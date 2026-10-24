import { join } from 'node:path'
import type { DlTask } from './jobs'
import type { FileConfig } from './config'
import type { GwClient } from './client'
import { downloadPlaylist, downloadProgress, headersFor, playlistStatus } from './media'
import { ensureFFmpeg, ensureMkvmerge } from './tools'
import { ffmpegConcat, validateAudio, validateVideoDecode } from './ffmpeg'
import { mkvmergeMux, mkvmergeRemux } from './mkvmerge'
import { mgtvCapabilities, miguCapabilities, selectedBilibiliMedia, webTracks, audioChoice, type WebTrack } from './web-video-providers'
import { probeFinishedMedia } from './gvs-record'
import { verifyMiguManifest } from './migu-manifest'
import { mgtvDurationCovers, mgtvExpectedDuration, mgtvRequestHeaders, verifyMgtvManifest } from './mgtv-manifest'
import { releaseGroup } from './release-group.ts'

type Emit = (status: string, pct: number, log: string) => void
async function verifyCoverage(path: string, expected: number | undefined, signal?: AbortSignal, strict = false) {
  signal?.throwIfAborted()
  const media = await probeFinishedMedia(path,signal)
  if (media.status !== 'probed' || !media.durationSeconds) throw new Error('未能验证媒体时长，已保留下载文件，请检查媒体工具')
  if (expected && (strict ? !mgtvDurationCovers(media.durationSeconds, expected) : expected > 30 && media.durationSeconds < expected - Math.max(10,expected*.05))) throw new Error('实际视频明显短于分集时长，可能是试看；已停止生成成品')
}
/**
 * 芒果 CDN 对本机出口成段拒绝（IP 节点 405 / 域名节点 403）。换节点也救不回来时，
 * 说明是出口 IP 被限流，只能等冷却或换网络；用专门的错误让上层给出准确提示。
 */
let mgtvBlockedUntil = 0

/** 记录"芒果正在拒绝本机出口"，让队列里的其它芒果任务先等一会儿，别再一起撞。 */
export function markMgtvBlocked(windowMs = 10 * 60_000): void {
  mgtvBlockedUntil = Math.max(mgtvBlockedUntil, Date.now() + windowMs)
}

/** 剩余冷却毫秒数（0 = 可以继续）。 */
export function mgtvBlockedFor(now = Date.now()): number {
  return Math.max(0, mgtvBlockedUntil - now)
}

export class MgtvCdnBlocked extends Error {
  readonly provider = 'mgtv'
  constructor(detail: string, options?: ErrorOptions) {
    super('芒果 CDN 正在拒绝本机出口（HTTP 403/405），通常是同一 IP 短时间下载过多被临时限流；请等 10–30 分钟，或更换网络/IP 后重试', options)
    this.name = 'MgtvCdnBlocked'
    this.detail = detail
  }
  readonly detail: string
}

export async function downloadWebVideo(cli: Pick<GwClient,'invoke'>, cfg: FileConfig, task: DlTask, dest: string, work: string, emit: Emit, signal?: AbortSignal, audioLanguageFallback = ''): Promise<void> {
  signal?.throwIfAborted()
  if (task.provider === 'migu') {
    const data = await cli.invoke('migu','resolve',{id:task.vid,quality:task.quality,...miguCapabilities(task.vid)})
    if (String(data.id) !== task.vid.replace(/^tv:/,'')) throw new Error('咪咕返回了不同分集，已停止下载')
    if (String(data.actualQuality) !== task.quality) throw new Error('咪咕所选画质已不可用，请重新选档')
    if (data.trial === true || Number(data.trialDuration)>0) throw new Error('咪咕返回试看片段，已停止下载')
    const source = webTracks(data).find(t=>t.type === 'video')
    if (!source || source.source.trial === true) throw new Error('咪咕没有返回完整可下载媒体')
    if (source.source.upstreamNeedClothHat === true || source.source.needClothHat === true) {
      emit('校验', .03, '本机核对咪咕清单的加密声明')
      await verifyMiguManifest(source.url, source.headers, signal)
    }
    await downloadPlaylist({src:source.url,dest,ref:'https://www.miguvideo.com/',headers:source.headers,threads:cfg.threads,select:'muxed',muxTracks:true,releaseGroup:releaseGroup(task,cfg),transport:'re',workDir:work,workTag:'migu',signal,cb:(n,total,info)=>emit(playlistStatus('下载',info?.phase||'download'),.05+.85*(total>1?n/total:n),info?.log||'咪咕 CDN → 本机')})
    // Existing queued tasks may contain the old minute-prefix duration (45:25 → 45).
    const resolvedDuration = Number(source.source.duration)
    const expected = Math.max(task.duration || 0, Number.isFinite(resolvedDuration) ? resolvedDuration : 0)
    await verifyCoverage(dest,expected || undefined,signal)
    return
  }
  if (task.provider === 'mgtv') {
    const data = await cli.invoke('mgtv','play',{vid:task.vid,quality:task.quality,...mgtvCapabilities})
    if (String(data.vid || data.id) !== task.vid) throw new Error('芒果取流返回了不同分集，已停止下载')
    if (String(data.actualQuality) !== task.quality) throw new Error('芒果返回了不同画质，已停止下载')
    const source = webTracks(data).find(t => t.type === 'video')
    if (!source) throw new Error('芒果没有返回可用播放地址')
    emit('校验', .03, data.preview === true || Number(data.preview) === 1 ? '核对芒果播放清单是否为完整内容' : '核对芒果播放清单')
    const expected = mgtvExpectedDuration(task.duration, data.duration, source.source.duration)
    // 芒果的签名在 URL 里，不需要 UA/Referer；实测带 UA 会被 IP 直连节点回 405、
    // 带 Referer 会被域名节点回 403，所以清单与分片都不带这两个头（清单仍保留兜底重试）。
    const headers = mgtvRequestHeaders(headersFor('', 0, source.headers))
    // 芒果的 CDN 节点会整段时间拒绝（IP 节点回 405、域名节点回 403），批量下载时尤其明显。
    // 死磕同一个 URL 没用，重新取流往往换到另一个节点，所以校验失败就重取再试。
    let checked: Awaited<ReturnType<typeof verifyMgtvManifest>>
    let current = source
    for (let attempt = 1; ; attempt++) {
      try {
        checked = await verifyMgtvManifest(current.url, headers, expected, signal)
        break
      } catch (error) {
        signal?.throwIfAborted()
        const message = error instanceof Error ? error.message : ''
        if (attempt >= 3 || !/HTTP (?:403|405|408|429|5\d\d)/.test(message)) {
          if (/HTTP (?:403|405)/.test(message)) {
            markMgtvBlocked()
            throw new MgtvCdnBlocked(message, { cause: error })
          }
          throw error
        }
        emit('校验', .03, `芒果清单被 CDN 拒绝，重新取流（第 ${attempt} 次）`)
        const fresh = await cli.invoke('mgtv', 'play', { vid: task.vid, quality: task.quality, ...mgtvCapabilities })
        const next = webTracks(fresh).find(t => t.type === 'video')
        if (!next) throw error
        current = next
      }
    }
    // 芒果对同一出口 IP 的并发很敏感：线程数收敛到 4，减少被限流的几率。
    await downloadPlaylist({src:checked.url,dest,ref:'',headers,threads:Math.min(cfg.threads || 8, 4),select:'muxed',muxTracks:true,releaseGroup:releaseGroup(task,cfg),
      // RE can synthesize an English language tag for an unlabeled TS audio
      // stream. A matched original language must be applied during our mux.
      muxOriginalAudioLanguage: audioLanguageFallback,transport:'re',workDir:work,workTag:'mgtv',signal,cb:(n,total,info)=>emit(playlistStatus('下载',info?.phase || 'download'),.05+.85*(total>1?n/total:n),info?.log || '芒果 CDN → 本机')})
    // A changed CDN playlist must not silently produce a short output after preflight.
    await verifyCoverage(dest,Math.max(expected || 0, checked.durationSeconds),signal,true)
    return
  }
  const [qn,family] = task.quality.split('|')
  const data = await cli.invoke('bilibili','resolve',{id:task.vid,quality:qn,...(['avc','hevc','av1'].includes(family || '') ? {codec:family} : {})})
  if (String(data.id) !== task.vid) throw new Error('B 站取流返回了不同分集，已停止下载')
  const audioIds = (task.audioTracks || []).filter(a=>a.id !== 'embedded').map(a=>a.id)
  const plan = selectedBilibiliMedia(data,task.quality,audioIds)
  const ffmpeg = await ensureFFmpeg(), mkvmerge = await ensureMkvmerge()
  const inputs = [...plan.videos,...plan.audios], paths: string[] = []
  for (let i=0;i<inputs.length;i++) {
    signal?.throwIfAborted()
    const track = inputs[i]!, path = join(work,`bili-${i}.mp4`)
    const urls = [track.url,...(Array.isArray(track.source.backupUrls) ? track.source.backupUrls.filter((v):v is string=>{
      if (typeof v !== 'string') return false
      try {const u=new URL(v);return ['http:','https:'].includes(u.protocol) && !u.username && !u.password}catch{return false}
    }) : [])]
    let successful = false
    for (const url of urls) {
      try {
        await downloadProgress(url,path,'https://www.bilibili.com/',(bytes,total)=>emit('下载',.05+.75*(i+(total>0?bytes/total:0))/inputs.length,`${track.type === 'audio' ? '音频' : '视频'} ${i+1}/${inputs.length}`),undefined,cfg.threads,undefined,track.headers,signal)
        successful=true;break
      } catch (error) { signal?.throwIfAborted(); if (url === urls.at(-1)) throw error }
    }
    if (!successful) throw new Error('B 站轨道下载失败')
    paths.push(path)
  }
  emit('校验',.82,'检查媒体轨道')
  for (const path of paths.slice(0,plan.videos.length)) {
    const errors = await validateVideoDecode(ffmpeg,path,signal)
    if (errors.length) throw new Error('B 站视频解码校验失败，已停止封装')
  }
  for (const path of paths.slice(plan.videos.length)) await validateAudio(ffmpeg,path,signal)
  emit('封装',.9,'本机合并视频和音频')
  if (!plan.videos[0]!.separate) {
    if (paths.length===1) await mkvmergeRemux(mkvmerge,paths[0]!,dest,undefined,signal,'',releaseGroup(task,cfg))
    else {
      const combined = join(work,'bili-combined.mkv')
      await ffmpegConcat(ffmpeg,paths,combined,signal)
      await mkvmergeRemux(mkvmerge,combined,dest,undefined,signal,'',releaseGroup(task,cfg))
    }
  } else {
    const audios = plan.audios.map((track:WebTrack,i:number) => ({path:paths[plan.videos.length+i]!,lang:'und',isDefault:task.audioTracks?.find(a=>a.id === audioChoice(track))?.isDefault}))
    await mkvmergeMux(mkvmerge,paths[0]!,audios,dest,undefined,signal,undefined,'',releaseGroup(task,cfg))
  }
  await verifyCoverage(dest,task.duration,signal)
}
