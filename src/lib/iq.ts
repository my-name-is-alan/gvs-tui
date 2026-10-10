import { spawnSync } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Audio, Quality } from '../types.ts'
import type { GwClient } from './client.ts'
import type { FileConfig } from './config.ts'
import { configPath } from './config.ts'
import type { DlTask } from './jobs.ts'
import { asString, isObj, sleep } from './util.ts'
import { CdnDenied, downloadPlaylist, downloadProgress, formatSpeed, headersFor, transferSpeed } from './media.ts'
import { ensureFFmpeg, ensureM3u8dl } from './tools.ts'
import { tierHeight } from './name.ts'
import { adoptIQResume, iqResumeIdentity, iqVideoComplete, markIQVideoComplete } from './iq-resume.ts'
import { IQCDNSlowError, iqCDNSlowGuard, rememberIQCDN, selectIQCDN } from './iq-cdn.ts'
import { downloadIQParts } from './iq-transfer.ts'
import { fetchMediaProbe } from './proxy.ts'
import { usesMeasuredNaming } from './completed-naming.ts'
import { muxIQ } from './iq-mux.ts'
import { selectIQSubtitles, type IQSubtitleFile } from './iq-subtitles.ts'
import { isUnknownAudioLanguage } from './audio-language.ts'

/** IQ's default track identifies the source-preferred language, not its codec tier. */
function iqAudioLanguage(row: Record<string, unknown>): string {
  const language = asString(row.language).trim().toLowerCase()
  if (!isUnknownAudioLanguage(language)) return `code:${language}`
  const lid = Number(row.lid)
  if (Number.isInteger(lid) && lid > 0) return `lid:${lid}`
  const name = asString(row.lang).trim().toLowerCase()
  return isUnknownAudioLanguage(name) ? '' : `name:${name}`
}

export function iqOptions(data: Record<string, unknown>): { qualities: Quality[]; audios: Audio[] } {
  const formats = Array.isArray(data.formats) ? data.formats.filter(isObj) : []
  const tracks = (Array.isArray(data.audios) ? data.audios.filter(isObj) : []).filter(a => asString(a.id))
  const qualities = formats.map(f => {
    const width = Number(f.width) || 0, height = Number(f.height) || 0, tier = tierHeight(width,height)
    const label = tier >= 2160 ? '4K' : tier ? `${tier}P` : asString(f.label)
    return { id: asString(f.id), label, title: `IQ TV · ${asString(f.codec).toUpperCase()}`, size: Number(f.size) || 0, width, height, codec: asString(f.codec), drm: Number(f.drm) === 5 ? 'IQ BBTS' : 'none', stream: asString(f.id), fps: Number(f.fps) || 25, tier }
  }).filter(f => f.id)
  const preferred = tracks.find(a => a.default === true)
  const languages = new Set(tracks.map(iqAudioLanguage).filter(Boolean))
  // Select every codec of the platform default language, never every dub.
  // With no default, a single known language is safe; otherwise retain just
  // one source track for manual confirmation rather than guessing by country.
  const initial = preferred ?? tracks[0]
  const mainLanguage = preferred ? iqAudioLanguage(preferred) : languages.size === 1 ? [...languages][0]! : ''
  const audios = tracks.map(a => ({ id: asString(a.id), label: asString(a.label), lang: asString(a.lang), codec: asString(a.codec), isDefault: a.default === true,
    selected: mainLanguage ? iqAudioLanguage(a) === mainLanguage : a === initial, embedded: false }))
  return { qualities, audios }
}

export function iqPlan(data: Record<string, unknown>): { playlist: string; key: string; rendition: string } {
  const video = isObj(data.video) ? data.video : {}
  const drm = isObj(data.drm) ? data.drm : {}
  const playlist = asString(video.playlist)
  if (!playlist.startsWith('#EXTM3U') || !playlist.includes('#EXT-X-ENDLIST')) throw new Error('IQ 未返回完整点播清单')
  const key = asString(drm.content_key_hex)
  if (drm.need_decrypt === true && !/^[a-f\d]{32}$/i.test(key)) throw new Error('IQ 当前片源缺少可用内容密钥')
  if (key && drm.scheme !== 'IQ_BBTS') throw new Error('IQ 未知解密算法，已停止')
  return { playlist, key, rendition: asString(video.vid) }
}

export function normalizeIQCookie(text: string): string {
  if (!text.includes('\t')) {
    if (/[\r\n]/.test(text)) throw new Error('IQ Cookie Header 不应包含换行')
    return text.trim()
  }
  return text.split(/\r?\n/).flatMap(line => {
    if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) return []
    const parts = line.split('\t'), host = (parts[0] || '').replace(/^#HttpOnly_/, '')
    return parts.length >= 7 && (host === 'iq.com' || host === '.iq.com' || host.endsWith('.iq.com')) ? [`${parts[5]}=${parts[6]}`] : []
  }).join('; ')
}

export async function downloadIQSubtitle(url: string, dest: string, signal?: AbortSignal): Promise<void> {
  const u = new URL(url)
  if (!['http:','https:'].includes(u.protocol) || u.username || u.password) throw new Error('IQ 媒体地址格式无效')
  const response = await fetch(url, { headers: headersFor('https://www.iq.com/'), signal })
  if (!response.ok || !response.body) throw new Error(`IQ CDN HTTP ${response.status}`)
  // fetch decodes HTTP gzip/br while Content-Length still describes the wire
  // bytes. Stream errors detect truncation; compare length only for identity.
  const encoding = response.headers.get('content-encoding')?.toLowerCase()
  const expected = !encoding || encoding === 'identity' ? Number(response.headers.get('content-length')) || 0 : 0
  let count = 0
  const reader = response.body.getReader()
  try {
    async function* chunks() {
      while (true) {
        const { value: chunk, done } = await reader.read()
        if (done) break
        signal?.throwIfAborted()
        count += chunk.byteLength
        yield chunk
      }
    }
    await pipeline(Readable.from(chunks()),createWriteStream(dest),{ signal })
  } finally {
    await reader.cancel().catch(()=>{})
    reader.releaseLock()
  }
  if (expected && count !== expected) throw new Error('IQ 下载字节数不完整')
}

export async function downloadIQ(cli: GwClient, cfg: FileConfig, task: DlTask, dest: string, work: string, emit: (status: string, pct: number, log: string) => void, signal?: AbortSignal): Promise<string> {
  const re = await ensureM3u8dl()
  const version = spawnSync(re,['--version'],{encoding:'utf8',windowsHide:true,timeout:10000})
  if (version.status !== 0 || !/gvs-iq\./i.test(version.stdout+version.stderr)) throw new Error('IQ 需要 GVS 自维护 RE，请更新内置工具或运行 build-managed-re')
  const play = () => cli.invoke('iq','play',{vid:task.vid,quality:task.quality},cli.extra(cfg,'iq'),{timeoutMs:150000})
  let data = await play()
  let plan = iqPlan(data)
  mkdirSync(work,{recursive:true})
  const manifest = join(work,'iq-video.m3u8'), video = join(work,'iq-video.ts')
  adoptIQResume(work,manifest,plan)
  const identity = iqResumeIdentity(plan)
  const videoStarted = Date.now()
  const preferencePath = join(dirname(configPath()), 'iq-cdn-preference.json'), excluded = new Set<string>()
  for (let retry=0; !iqVideoComplete(video,identity); retry++) {
    signal?.throwIfAborted()
    const route = await selectIQCDN(plan.playlist, isObj(data.video) ? data.video.cdnCandidates : undefined, {
      preferencePath, headers: headersFor('https://www.iq.com/'), signal, excluded,
      note: message => emit('CDN 优选',0.02,message),
    })
    plan = { ...plan, playlist: route.playlist }
    writeFileSync(manifest,plan.playlist,{mode:0o600})
    emit('视频下载',0.02,'校验片源后续传，保留已完成分片')
    const routeAbort = new AbortController(), slow = iqCDNSlowGuard()
    const downloadSignal = signal ? AbortSignal.any([signal,routeAbort.signal]) : routeAbort.signal
    try {
      await downloadPlaylist({src:manifest,dest:video,ref:'https://www.iq.com/',key:plan.key,keyMethod:'IQ_BBTS',select:'video',threads:cfg.threads,workDir:work,workTag:'iq-video',resumeIdentity:identity,signal:downloadSignal,cb:(n,total,info)=>{
        emit(info?.phase==='decrypt'?'视频解密':info?.phase==='merge'?'视频合并':'视频下载',0.02+0.66*(total>1?n/total:n),formatSpeed(n,total,(Date.now()-videoStarted)/1000,info))
        if (retry<2 && route.alternatives && slow(info?.phase,info?.transfer?.bytesPerSecond)) routeAbort.abort(new IQCDNSlowError())
      }})
      markIQVideoComplete(video,identity)
      if (route.hosts[0]) rememberIQCDN(preferencePath,route.hosts[0])
    } catch (error) {
      signal?.throwIfAborted()
      const transient = error instanceof IQCDNSlowError || error instanceof CdnDenied && [403,408,410,429,500,502,503,504].includes(error.status) ||
        error instanceof Error && /ResponseEnded|premature|timed?\s*out|connection.*(?:reset|closed)|unexpected.*end/i.test(error.message)
      if (!transient || retry >= 2) throw error
      route.hosts.forEach(host => excluded.add(host))
      emit('重试',0.02,`CDN 响应异常或持续低速，重新优选并续传 ${retry+1}/2`)
      await sleep(2000*(retry+1),signal)
      data = await play()
      plan = iqPlan(data)
      if (iqResumeIdentity(plan) !== identity) throw new Error('IQ 重新取链后片源或密钥改变，原分片已保留，请重新探测')
    }
  }
  const available = Array.isArray(data.audios) ? data.audios.filter(isObj) : []
  const requested = task.audioTracks?.length ? task.audioTracks.map(t => t.id) : available.filter(a => a.default === true).map(a => asString(a.id))
  if (!requested.length) throw new Error('IQ 没有返回默认独立音轨，请重新探测')
  const audioFiles: Array<{path:string;language:string;title:string;isDefault:boolean}> = []
  for (const [index,id] of requested.entries()) {
    signal?.throwIfAborted()
    emit('音轨下载',0.70+0.12*index/requested.length,`独立音轨 ${index+1}/${requested.length}`)
    const audio = await cli.invoke('iq','audio',{vid:task.vid,audioId:id,renditionVid:plan.rendition},cli.extra(cfg,'iq'),{timeoutMs:150000})
    if (audio.clear !== true) throw new Error('IQ 独立音轨没有明确标记明文，已停止')
    const parts = Array.isArray(audio.parts) ? audio.parts.filter(isObj) : []
    if (!parts.length) throw new Error('IQ 独立音轨分段为空')
    const paths = parts.map((_,pi)=>join(work,`iq-audio-${index}-${pi}.part`))
    const started=Date.now(), measure=transferSpeed()
    await downloadIQParts(parts.map((part,pi)=>({url:asString(part.url),path:paths[pi]!})),{
      identity:JSON.stringify([task.vid,plan.rendition,id]),threads:cfg.threads,headers:headersFor('https://www.iq.com/'),signal,
      downloadRanges:(url,path,threads,received,abort)=>downloadProgress(url,path,'https://www.iq.com/',received,undefined,threads,undefined,undefined,abort,fetchMediaProbe),
      progress:(bytes,done,total)=>emit('音轨下载',0.70+0.12*(index+Math.min(1,Number(audio.size)>0?bytes/Number(audio.size):done/Math.max(1,total)))/requested.length,
        formatSpeed(0,1,(Date.now()-started)/1000,{segments:{done,total},transfer:measure(bytes)})),
    })
    const joined = join(work,`iq-audio-${index}.m4a`)
    function* audioChunks() {
      for (const [pi,path] of paths.entries()) {
        let bytes = readFileSync(path)
        if (pi===0 && bytes[0]===0x1f && bytes[1]===0x8b) bytes=gunzipSync(bytes)
        yield bytes
      }
    }
    await pipeline(Readable.from(audioChunks()),createWriteStream(joined),{ signal })
    const isDefault = task.audioTracks?.length ? task.audioTracks.find(t => t.id === id)?.isDefault === true
      : available.find(a => asString(a.id) === id)?.default === true
    audioFiles.push({path:joined,language:asString(audio.language)||'und',title:asString(audio.title)||'原声',isDefault})
  }
  const availableSubs = (Array.isArray(data.subtitles) ? data.subtitles.filter(isObj) : []).map(sub => ({
    url: asString(sub.url), format: asString(sub.format).toLowerCase(), language: asString(sub.lang) || 'und',
    title: asString(sub.label), ai: sub.ai === true,
  }))
  const subs = selectIQSubtitles(availableSubs)
  const subtitleFiles: IQSubtitleFile[] = []
  emit('字幕下载',0.84,`${subs.length} 条字幕；优先正常简繁，缺失时 OpenCC 补齐`)
  for (const [index,sub] of subs.entries()) {
    const path = join(work,`iq-sub-${index}.${sub.format==='vtt'?'vtt':'srt'}`)
    await downloadIQSubtitle(sub.url,path,signal)
    const bytes = readFileSync(path)
    if (bytes[0]===0x1f && bytes[1]===0x8b) writeFileSync(path,gunzipSync(bytes))
    subtitleFiles.push({path,language:sub.language,title:sub.title,ai:sub.ai})
  }
  emit('封装',0.9,'保留原始视频、独立音轨和字幕')
  const measured = usesMeasuredNaming(task)
  const muxAudio = await muxIQ(await ensureFFmpeg(), {video,audios:audioFiles,subtitles:subtitleFiles,
    dest,reservedOutput:measured,signal,emit})
  if (measured) task.namingEvidence = { muxAudio: { index: muxAudio.index, count: muxAudio.count } }
  return muxAudio.note || ''
}
