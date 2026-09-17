import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import type { FileConfig } from './config.ts'
import type { GwClient } from './client.ts'
import { ffmpegDecryptCopy, ffmpegRemux, validateAudio } from './ffmpeg.ts'
import { mkvmergeMux, mkvmergeRemux, type MuxAudio } from './mkvmerge.ts'
import { ensureFFmpeg, ensureMkvmerge } from './tools.ts'
import { filename, folder, sourceTag } from './name.ts'
import type { MediaKind, Naming } from './name.ts'
import { writeEpisodeNFO, writeMovieNFO, writeTvShowNFO } from './nfo.ts'
import {
  CdnDenied, downloadPlaylist, downloadProgress, pickDouyinURL, pickHongguo, pickURL, referer, speedCB,
  youkuAudioPlaylist, youkuVideoPlaylist,
} from './media.ts'
import type { RetryNote } from './media.ts'
import { retryCdnRefresh } from './cdn-retry.ts'
import { asString, human, isObj } from './util.ts'
import type { Job } from '../types.ts'

export type DlTask = {
  provider: string
  title: string
  series: string
  vid: string
  url?: string
  season: number
  episode: number
  height: number
  quality: string
  /** Audio tracks to mux in (空格勾选的那些）；空 = 只封平台默认音轨。 */
  audioTracks?: Array<{ id: string; label: string; lang: string }>
  group: string
  codec: string
  tmdbId: number
  nameDots: string
  year: number
  plot: string
  kind?: MediaKind
  edition?: string
}

export type JobEvt = { id: number; status: string; pct: number; log: string; err: string; done?: boolean }

export function youkuDRM(payload: Record<string, unknown>) {
  const drm = isObj(payload.drm) ? payload.drm : {}
  const key = asString(drm.content_key_hex).replace(/^0x/i, '').replace(/-/g, '').toLowerCase()
  const kid = (asString(drm.kid) || asString(drm.key_id)).replace(/^0x/i, '').replace(/-/g, '').toLowerCase()
  const clear = drm.actually_clear === true || drm.need_decrypt === false
  // 0:0 is full-block CBC encryption, NOT a clear audio track.
  return { reKey: key ? (/^[a-f\d]{32}$/i.test(kid) ? `${kid}:${key}` : key) : '', videoEnc: !clear, audioEnc: !clear }
}

let jobSeq = 0
export function nextJobID(): number {
  jobSeq += 1
  return jobSeq
}

export class JobHub {
  private readonly q: Array<() => Promise<void>> = []
  private active = 0

  constructor(private readonly onEvt: (e: JobEvt) => void) {}

  enqueue(cfg: FileConfig, cli: GwClient, id: number, t: DlTask): void {
    this.q.push(() => runTask(this.onEvt, cfg, cli, id, t))
    this.pump()
  }

  private pump(): void {
    while (this.active < 2 && this.q.length) {
      const fn = this.q.shift()!
      this.active += 1
      void fn().finally(() => {
        this.active -= 1
        this.pump()
      })
    }
  }
}

export function jobTitle(t: DlTask): string {
  if (t.provider === 'douyin') {
    const title = t.series || t.title || t.vid
    return t.quality ? `${title} ${t.quality}` : title
  }
  if (t.kind === 'movie') {
    let title = t.series
    if (t.edition) title += ` ${t.edition}`
    if (t.quality) title += ` ${t.quality}`
    return title
  }
  let title = `${t.series} E${String(t.episode).padStart(2, '0')}`
  if (t.quality) title += ` ${t.quality}`
  return title
}

async function runTask(
  emitEvt: (e: JobEvt) => void,
  cfg: FileConfig,
  cli: GwClient,
  id: number,
  t: DlTask,
): Promise<void> {
  // Surface CDN retries in the job row instead of letting the bar sit still.
  let lastPct = 0
  const emit = (status: string, pct: number, log: string) => {
    lastPct = Math.max(lastPct, Math.min(0.99, Number.isFinite(pct) ? pct : lastPct))
    emitEvt({ id, status, pct: lastPct, log, err: '' })
  }
  const retryNote = (attempt: number, total: number, why: string) => {
    emitEvt({ id, status: '重试', pct: lastPct, log: `第 ${attempt}/${total} 次 · ${why}`, err: '' })
  }
  try {
    const kind: MediaKind = t.kind ?? (t.provider === 'hongguo' || t.provider === 'douyin' ? 'short' : 'show')
    const n: Naming = {
      kind,
      title: t.series || t.title,
      nameDots: t.nameDots,
      year: t.year,
      season: t.season,
      episode: t.episode,
      height: t.height,
      codec: t.codec || 'H264',
      edition: t.edition,
      source: sourceTag(t.provider),
      group: t.provider === 'douyin' ? '' : (t.group.trim() || cfg.releaseGroup),
      tmdbId: t.tmdbId,
      container: t.provider === 'douyin' ? 'mp4' : t.provider === 'hongguo' && cfg.hongguoFmt ? cfg.hongguoFmt : 'mkv',
    }
    const dir = t.provider === 'douyin' ? cfg.outDir : folder(n, cfg.outDir)
    mkdirSync(dir, { recursive: true })
    const out = join(dir, filename(n))
    const ffmpeg = t.provider === 'hongguo' ? await ensureFFmpeg() : ''
    const mkvmerge = n.container === 'mkv' ? await ensureMkvmerge() : ''
    if (n.container === 'mkv' && !mkvmerge) throw new Error('没有 mkvmerge')
    emit('取链', 0.01, out.split(/[/\\]/).pop() ?? out)
    switch (t.provider) {
      case 'hongguo':
        await dlHongguo(cli, t, dir, out, ffmpeg, mkvmerge, emit, retryNote, cfg.threads)
        break
      case 'youku':
        await dlYouku(cli, cfg, t, dir, out, mkvmerge, emit, retryNote)
        break
      case 'tencent':
        await dlTencent(cli, cfg, t, dir, out, mkvmerge, emit, retryNote)
        break
      case 'douyin':
        await dlDouyin(cli, t, out, emit, retryNote)
        break
      default:
        throw new Error(`demo 尚未接 ${t.provider} 下载管线`)
    }
    if (t.provider === 'hongguo' && cfg.hongguoNfo) {
      writeTvShowNFO(dir, t.series, t.plot, 0)
      writeEpisodeNFO(out, t.title, t.season, t.episode, '')
    }
    if ((t.provider === 'youku' || t.provider === 'tencent') && t.tmdbId > 0) {
      if (kind === 'movie') {
        writeMovieNFO(dir, t.series, t.plot, t.tmdbId, t.year)
      } else {
        writeTvShowNFO(t.season > 0 ? dirname(dir) : dir, t.series, t.plot, t.tmdbId)
        writeEpisodeNFO(out, t.title, t.season, t.episode, '')
      }
    }
    emitEvt({ id, status: '完成', pct: 1, log: out, err: '', done: true })
  } catch (e) {
    emitEvt({ id, status: '失败', pct: lastPct, log: '', err: e instanceof Error ? e.message : String(e), done: true })
  }
}

async function dlHongguo(
  cli: GwClient, t: DlTask, dir: string, out: string, ffmpeg: string, mkvmerge: string,
  emit: (s: string, p: number, l: string) => void,
  retryNote: RetryNote,
  threads: number,
): Promise<void> {
  emit('取链', 0.02, t.vid)
  const data = await cli.invoke('hongguo', 'resolve', { vid: t.vid, platform: 'ios' })
  const picked = pickHongguo(data, t.vid, t.quality)
  if (!picked.cdn) throw new Error(picked.why ? `红果: ${picked.why}` : `红果没有 CDN  vid=${t.vid}`)
  let key = ''
  if (picked.spade) {
    emit('密钥', 0.05, '')
    try {
      const kd = await cli.invoke('hongguo', 'key', { spade: picked.spade })
      key = asString(kd.key) || asString(kd.content_key_hex)
    } catch (e) {
      throw new Error(`红果获取密钥失败：${e instanceof Error ? e.message : String(e)}`)
    }
    if (!/^[a-f\d]{32}$/i.test(key)) throw new Error('红果未返回有效解密密钥')
  }
  const enc = join(dir, `.${t.vid}.enc.mp4`)
  emit('下载', 0.08, '')
  try {
    await downloadProgress(picked.cdn, enc, referer(t.provider), speedCB(emit, '下载', 0.08, 0.7), retryNote, threads)
  } catch (e) {
    // 红果直链带 expire；403 说明链接过期，重新 resolve 一次再续传。
    if (!(e instanceof CdnDenied)) throw e
    emit('重取', 0.08, `CDN ${e.status}，重新取链后续传`)
    const again = pickHongguo(await cli.invoke('hongguo', 'resolve', { vid: t.vid, platform: 'ios' }), t.vid, t.quality)
    if (!again.cdn) throw new Error('红果重新取链失败')
    await downloadProgress(again.cdn, enc, referer(t.provider), speedCB(emit, '下载', 0.08, 0.7), retryNote, threads)
  }
  const tmp = join(dir, `.${t.vid}.mp4`)
  emit('解密', 0.78, '')
  if (key) {
    await ffmpegDecryptCopy(ffmpeg, key, enc, tmp, (n, total) => emit('解密', 0.78 + 0.07 * Math.min(1, n / total), `解密 ${human(n)}/${human(total)}`))
    try { unlinkSync(enc) } catch { /* keep */ }
  } else {
    renameSync(enc, tmp)
  }
  emit('封装', 0.86, out)
  try {
    if (mkvmerge) {
      await mkvmergeRemux(mkvmerge, tmp, out, (n, total) => emit('封装', 0.86 + 0.13 * (n / total), `封装 ${human(n)}/${human(total)}`))
    } else {
      await ffmpegRemux(ffmpeg, tmp, out, (n, total) => emit('封装', 0.86 + 0.13 * (n / total), `封装 ${human(n)}/${human(total)}`))
    }
  } catch {
    renameSync(tmp, out.slice(0, out.length - extname(out).length) + '.mp4')
    throw new Error('封装失败')
  }
  try { unlinkSync(tmp) } catch { /* keep */ }
}

async function dlTencent(
  cli: GwClient, cfg: FileConfig, t: DlTask, dir: string, out: string, mkvmerge: string,
  emit: (s: string, p: number, l: string) => void,
  retryNote: RetryNote,
): Promise<void> {
  emit('取链', 0.05, t.vid)
  const play = () => cli.invoke('tencent', 'play', { vid: t.vid, defn: t.quality || 'fhd' }, cli.extra(cfg, 'tencent'))
  let cdn = pickURL(await play())
  if (!cdn) throw new Error('腾讯没有 video.url')
  const raw = join(dir, `.${t.vid}.bin`)
  emit('下载', 0.1, '')
  try {
    await downloadProgress(cdn, raw, referer('tencent'), speedCB(emit, '下载', 0.1, 0.75), retryNote, cfg.threads)
  } catch (e) {
    if (!(e instanceof CdnDenied)) throw e
    emit('重取', 0.1, `CDN ${e.status}，重新取链后续传`)
    cdn = pickURL(await play())
    if (!cdn) throw new Error('腾讯重新取链失败')
    await downloadProgress(cdn, raw, referer('tencent'), speedCB(emit, '下载', 0.1, 0.75), retryNote, cfg.threads)
  }
  emit('封装', 0.86, out)
  await mkvmergeRemux(mkvmerge, raw, out, (n, total) => emit('封装', 0.86 + 0.13 * (n / total), `封装 ${human(n)}/${human(total)}`))
  try { unlinkSync(raw) } catch { /* keep */ }
}

async function dlDouyin(
  cli: GwClient, t: DlTask, out: string,
  emit: (s: string, p: number, l: string) => void,
  retryNote: RetryNote,
): Promise<void> {
  emit('取链', 0.02, t.vid || t.url || '')
  const url = (t.url || '').trim() || (t.vid ? `https://www.douyin.com/video/${t.vid}` : '')
  if (!url) throw new Error('没有抖音链接')
  const resolve = async () => {
    const cdn = pickDouyinURL(await cli.invoke('douyin', 'resolve', { url }))
    if (!cdn) throw new Error('抖音没有直链')
    return cdn
  }
  let cdn = await resolve()
  emit('下载', 0.1, cdn)
  try {
    await downloadProgress(cdn, out, referer('douyin'), speedCB(emit, '下载', 0.1, 0.85), retryNote, 4)
  } catch (e) {
    if (!(e instanceof CdnDenied)) throw e
    emit('重取', 0.1, `CDN ${e.status}，重新解析后续传`)
    cdn = await resolve()
    await downloadProgress(cdn, out, referer('douyin'), speedCB(emit, '下载', 0.1, 0.85), retryNote, 4)
  }
}

async function dlYouku(
  cli: GwClient, cfg: FileConfig, t: DlTask, dir: string, out: string, mkvmerge: string,
  emit: (s: string, p: number, l: string) => void,
  retryNote: RetryNote,
): Promise<void> {
  const tracks = t.audioTracks?.length ? t.audioTracks : [{ id: '', label: '默认音轨', lang: '' }]
  const videoPath = join(dir, `.${t.vid}.video.mp4`)
  const muxInputs: MuxAudio[] = []
  const temps = new Set<string>()
  const completedTracks = new Set<string>()
  let succeeded = false

  const pull = async (
    src: string,
    dest: string,
    key: string | undefined,
    label: string,
    base: number,
    span: number,
    select: 'video' | 'audio',
    trackId = '',
  ) => {
    // A later audio failure must not download an already completed video again.
    // This set belongs to one task/quality and is never inferred from old files.
    if (completedTracks.has(dest)) return
    await downloadPlaylist({
      src,
      dest,
      ref: referer('youku'),
      key,
      clear: !key,
      threads: cfg.threads,
      select,
      transport: 'node',
      refreshSource: async () => {
        const payload = await playYouku(cli, cfg, t)
        const drm = youkuDRM(payload)
        const src = select === 'video' ? youkuVideoPlaylist(payload, t.quality) : youkuAudioPlaylist(payload, trackId)
        if (!src) throw new Error('重新取链后缺少所选轨道')
        return { src, key: (select === 'video' ? drm.videoEnc : drm.audioEnc) ? drm.reKey : undefined }
      },
      onRefresh: (retry, total) => retryNote(retry, total, `${label} 失败分片换新 CDN 链接，保留已下载进度`),
      cb: (n, total) => {
        const pct = total > 1 ? n / total : n
        emit(label, base + span * pct, label)
      },
    })
    completedTracks.add(dest)
  }

  const run = async (payload: Record<string, unknown>) => {
    muxInputs.length = 0
    temps.add(videoPath)
    const drm = youkuDRM(payload)
    if ((drm.videoEnc || drm.audioEnc) && !drm.reKey) throw new Error('优酷加密轨道未返回密钥，请重试取流或检查登录状态')
    const playlist = youkuVideoPlaylist(payload, t.quality)
    if (!playlist) throw new Error('优酷 play 没有 playlist_url')
    emit('下载', 0.05, playlist.split(/[?#]/)[0]?.split('/').pop() ?? '')
    await pull(playlist, videoPath, drm.videoEnc ? drm.reKey : undefined, '下载', 0.05, 0.62, 'video')
    for (const [i, track] of tracks.entries()) {
      // Video download/decryption can outlive the original audio URL lease.
      const audioPayload = await playYouku(cli, cfg, t)
      const audioDrm = youkuDRM(audioPayload)
      if (audioDrm.audioEnc && !audioDrm.reKey) throw new Error('重新取得的音轨缺少解密密钥')
      const audioPl = youkuAudioPlaylist(audioPayload, track.id)
      if (!audioPl) throw new Error(`所选音轨没有播放列表：${track.label}`)
      const audioPath = join(dir, `.${t.vid}.audio${i}.mp4`)
      temps.add(audioPath)
      await pull(
        audioPl,
        audioPath,
        audioDrm.audioEnc ? audioDrm.reKey : undefined,
        `音轨 ${track.label}`,
        0.67 + 0.18 * i / tracks.length,
        0.18 / Math.max(1, tracks.length),
        'audio',
        track.id,
      )
      muxInputs.push({ path: audioPath, title: track.label, lang: track.lang })
    }
  }

  try {
    await retryCdnRefresh(async () => run(await playYouku(cli, cfg, t)), (retry, total, delayMs, status) => {
      retryNote(retry, total, `CDN ${status}，${delayMs / 1000} 秒后重新取链`)
    })

    emit('校验', 0.85, '检查音轨完整解码')
    const ffmpeg = await ensureFFmpeg()
    for (const input of muxInputs) await validateAudio(ffmpeg, input.path)
    emit('封装', 0.86, muxInputs.length > 1 ? `封装 ${muxInputs.length} 条音轨` : out)
    const muxProgress = (n: number, total: number) => emit('封装', 0.86 + 0.13 * (n / total), `封装 ${human(n)}/${human(total)}`)
    const partial = join(dir, `.${t.vid}.mux-partial.mkv`)
    temps.add(partial)
    try {
      if (muxInputs.length) await mkvmergeMux(mkvmerge, videoPath, muxInputs, partial, muxProgress)
      else await mkvmergeRemux(mkvmerge, videoPath, partial, muxProgress)
      await validateAudio(ffmpeg, partial)
      renameSync(partial, out)
      if (existsSync(`${partial}.timing.json`)) renameSync(`${partial}.timing.json`, `${out}.timing.json`)
      succeeded = true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/channel element|Prediction is not allowed|is not allocated|Error submitting packet/i.test(msg)) {
        throw new Error('片源超出试看段后无法解码（未登录或非会员）：设置 → 优酷扫码 登录后重下')
      }
      throw e
    }
  } finally {
    // Failed muxes retain original tracks for diagnosis/retry. Developers can
    // opt into retaining successful downloads too, without editing config.
    if (succeeded && process.env.GVS_KEEP_INTERMEDIATES !== '1') await cleanupTemporaryFiles(temps)
  }
}

/** Clean only paths owned by this job; never scan or delete another active job. */
export async function cleanupTemporaryFiles(paths: Iterable<string>): Promise<void> {
  const failed: string[] = []
  for (const path of paths) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { unlinkSync(path); break }
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOENT') break
        if (attempt < 4 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
          await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
          continue
        }
        failed.push(path)
        break
      }
    }
  }
  if (failed.length) throw new Error(`临时文件清理失败：${failed.join('、')}`)
}

async function playYouku(cli: GwClient, cfg: FileConfig, t: DlTask): Promise<Record<string, unknown>> {
  // RE/relay reads the selected playlist; expanding every track here fetches
  // unused playlists and adds latency to every signed-URL refresh.
  const input: Record<string, unknown> = { vid: t.vid, expand: '0', tier: t.quality ? 'multi' : 'single', nocache: '1' }
  return cli.invoke('youku', 'play', input, cli.extra(cfg, 'youku'))
}



export function patchJob(jobs: Job[], e: JobEvt): void {
  const row = jobs.find((j) => j.id === e.id)
  if (!row) return
  row.status = e.status
  row.pct = e.pct
  row.log = e.log
  row.err = e.err
}
