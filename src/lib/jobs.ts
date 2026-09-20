import { tencentPlayInput } from './tencent-qr.ts'
import { resolveHongguoDownload } from './hongguo.ts'
import { mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { FileConfig } from './config.ts'
import type { GwClient } from './client.ts'
import { audioTrackLabel, ffmpegDecryptCopy, ffmpegRemux, validateAudio } from './ffmpeg.ts'
import { mkvmergeMux, mkvmergeRemux, type MuxAudio } from './mkvmerge.ts'
import { ensureFFmpeg, ensureMkvmerge, ensureMP4Box } from './tools.ts'
import { isDtsAudio, mp4boxMux, readMp4Tracks } from './mp4box.ts'
import { filename, folder, sourceTag } from './name.ts'
import type { MediaKind, Naming } from './name.ts'
import { writeEpisodeNFO, writeTvShowNFO } from './nfo.ts'
import {
  CdnDenied, downloadPlaylist, downloadProgress, pickDouyinURL, pickURL, playlistStatus, referer, speedCB,
  youkuAudioPlaylist, youkuVideoPlaylist,
} from './media.ts'
import type { RetryNote } from './media.ts'
import { retryCdnRefresh } from './cdn-retry.ts'
import { asString, human, isObj } from './util.ts'
import type { Job } from '../types.ts'
import { moveFileSync } from './file-move.ts'

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
  audioTracks?: Array<{ id: string; label: string; lang: string; vid?: string }>
  group: string
  codec: string
  tmdbId: number
  nameDots: string
  year: number
  plot: string
  kind?: MediaKind
  edition?: string
  languages?: Array<{ vid: string; lang: string }>
}

export type JobEvt = { id: number; status: string; pct: number; log: string; err: string; done?: boolean }

type JobRunner = (
  emit: (e: JobEvt) => void,
  cfg: FileConfig,
  cli: GwClient,
  id: number,
  t: DlTask,
) => Promise<void>

type QueuedJob = { provider: string; run: () => Promise<void> }

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
  private readonly q: QueuedJob[] = []
  private active = 0
  private youkuActive = 0

  constructor(
    private readonly onEvt: (e: JobEvt) => void,
    private readonly start: JobRunner = runTask,
  ) {}

  enqueue(cfg: FileConfig, cli: GwClient, id: number, t: DlTask): void {
    this.q.push({
      provider: t.provider,
      run: () => this.start(this.onEvt, cfg, cli, id, t),
    })
    this.pump()
  }

  private pump(): void {
    for (let i = 0; i < this.q.length && this.active < 2; ) {
      const item = this.q[i]!
      // Two Youku CENC jobs share Shaka/RE temp names and one UPS session.
      // English+Mandarin editions in parallel decrypt with a mixed key.
      if (item.provider === 'youku' && this.youkuActive > 0) {
        i++
        continue
      }
      this.q.splice(i, 1)
      this.active += 1
      if (item.provider === 'youku') this.youkuActive += 1
      void item.run().finally(() => {
        this.active -= 1
        if (item.provider === 'youku') this.youkuActive -= 1
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
      container: t.provider === 'douyin' || (t.provider === 'youku' && t.audioTracks?.some(isDtsAudio))
        ? 'mp4' : t.provider === 'hongguo' && cfg.hongguoFmt ? cfg.hongguoFmt : 'mkv',
    }
    const dir = t.provider === 'douyin' ? cfg.outDir : folder(n, cfg.outDir)
    mkdirSync(dir, { recursive: true })
    let out = join(dir, filename(n))
    const ffmpeg = t.provider === 'hongguo' ? await ensureFFmpeg() : ''
    const mkvmerge = n.container === 'mkv' ? await ensureMkvmerge() : ''
    if (n.container === 'mkv' && !mkvmerge) throw new Error('没有 mkvmerge')
    emit('取链', 0.01, out.split(/[/\\]/).pop() ?? out)
    switch (t.provider) {
      case 'hongguo':
        await dlHongguo(cli, t, dir, out, ffmpeg, mkvmerge, emit, retryNote, cfg.threads)
        break
      case 'youku':
        out = await dlYouku(cli, cfg, t, dir, out, mkvmerge, emit, retryNote)
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
  let picked = await resolveHongguoDownload(cli, t.vid, t.quality)
  const enc = join(dir, `.${t.vid}.enc.mp4`)
  emit('下载', 0.08, '')
  try {
    await downloadProgress(picked.cdn, enc, referer(t.provider), speedCB(emit, '下载', 0.08, 0.7), retryNote, threads)
  } catch (e) {
    // CDN 拒绝旧链接时重新获取成对的 URL 和 key。
    if (!(e instanceof CdnDenied)) throw e
    emit('重取', 0.08, `CDN ${e.status}，重新取链后下载`)
    picked = await resolveHongguoDownload(cli, t.vid, t.quality)
    // A refreshed URL may identify different bytes; restart to keep CDN and key paired.
    try { unlinkSync(enc) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await downloadProgress(picked.cdn, enc, referer(t.provider), speedCB(emit, '下载', 0.08, 0.7), retryNote, threads)
  }
  const tmp = join(dir, `.${t.vid}.mp4`)
  emit('解密', 0.78, '')
  if (picked.key) {
    await ffmpegDecryptCopy(ffmpeg, picked.key, enc, tmp, (n, total) => emit('解密', 0.78 + 0.07 * Math.min(1, n / total), `解密 ${human(n)}/${human(total)}`))
    try { unlinkSync(enc) } catch { /* keep */ }
  } else {
    moveFileSync(enc, tmp)
  }
  emit('封装', 0.86, out)
  try {
    if (mkvmerge) {
      await mkvmergeRemux(mkvmerge, tmp, out, (n, total) => emit('封装', 0.86 + 0.13 * (n / total), `封装 ${human(n)}/${human(total)}`))
    } else {
      await ffmpegRemux(ffmpeg, tmp, out, (n, total) => emit('封装', 0.86 + 0.13 * (n / total), `封装 ${human(n)}/${human(total)}`))
    }
  } catch {
    moveFileSync(tmp, out.slice(0, out.length - extname(out).length) + '.mp4')
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
  const play = () => cli.invoke('tencent', 'play', { vid: t.vid, defn: t.quality || 'fhd', ...tencentPlayInput(cfg) }, cli.extra(cfg, 'tencent'))
  let cdn = pickURL(await play())
  if (!cdn) throw new Error('腾讯没有 video.url')
  const raw = join(dir, `.${t.vid}.bin`)
  emit('下载', 0.1, '')
  try {
    await downloadProgress(cdn, raw, referer('tencent'), speedCB(emit, '下载', 0.1, 0.75), retryNote, cfg.threads)
  } catch (e) {
    if (!(e instanceof CdnDenied)) throw e
    emit('重取', 0.1, `CDN ${e.status}，重新取链后下载`)
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
): Promise<string> {
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
        const payload = await playYouku(cli, cfg, t, select === 'audio' ? trackVid(t, trackId) : t.vid)
        const drm = youkuDRM(payload)
        const src = select === 'video' ? youkuVideoPlaylist(payload, t.quality) : youkuAudioPlaylist(payload, trackId)
        if (!src) throw new Error('重新取链后缺少所选轨道')
        return { src, key: (select === 'video' ? drm.videoEnc : drm.audioEnc) ? drm.reKey : undefined }
      },
      onRefresh: (retry, total) => retryNote(retry, total, `${label} 失败分片换新 CDN 链接，保留已下载进度`),
      cb: (n, total, info) => {
        const pct = total > 1 ? n / total : n
        const status = playlistStatus(label, info?.phase ?? 'download')
        emit(status, base + span * pct, info?.log || status)
      },
    })
    completedTracks.add(dest)
  }

  const run = async (payload: Record<string, unknown>) => {
    muxInputs.length = 0
    temps.add(videoPath)
    temps.add(`${videoPath}.transport.json`)
    temps.add(`${videoPath}.download-error.log`)
    const drm = youkuDRM(payload)
    if ((drm.videoEnc || drm.audioEnc) && !drm.reKey) throw new Error('优酷加密轨道未返回密钥，请重试取流或检查登录状态')
    const playlist = youkuVideoPlaylist(payload, t.quality)
    if (!playlist) throw new Error('优酷 play 没有 playlist_url')
    emit('下载', 0.05, playlist.split(/[?#]/)[0]?.split('/').pop() ?? '')
    await pull(playlist, videoPath, drm.videoEnc ? drm.reKey : undefined, '下载', 0.05, 0.62, 'video')
    for (const [i, track] of tracks.entries()) {
      // Video download/decryption can outlive the original audio URL lease.
      const audioVid = trackVid(t, track.id, track.vid)
      const audioPayload = await playYouku(cli, cfg, t, audioVid)
      const audioDrm = youkuDRM(audioPayload)
      if (audioDrm.audioEnc && !audioDrm.reKey) throw new Error('重新取得的音轨缺少解密密钥')
      const audioPl = youkuAudioPlaylist(audioPayload, track.id)
      if (!audioPl) throw new Error(`所选音轨没有播放列表：${track.label}`)
      const audioPath = join(dir, `.${t.vid}.audio${i}.mp4`)
      temps.add(audioPath)
      temps.add(`${audioPath}.transport.json`)
      temps.add(`${audioPath}.download-error.log`)
      await pull(
        audioPl,
        audioPath,
        audioDrm.audioEnc ? audioDrm.reKey : undefined,
        `音轨 ${[track.lang, track.label].filter(Boolean).join(' ')}`,
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

    // Inspect the actual sample entry as well as the selected label: a default
    // track may be DTS without an explicit selection in the task.
    const mp4box = await ensureMP4Box()
    const audioInfo = []
    for (const input of muxInputs) audioInfo.push(await readMp4Tracks(mp4box, input.path))
    const dts = tracks.some(isDtsAudio) || audioInfo.some(list => list.some(t => /^dts[cehlxy]$/.test(t.codec)))
    if (dts) out = out.slice(0, out.length - extname(out).length) + '.mp4'
    emit('校验', 0.85, dts ? '检查 MP4 轨道和时间戳（DTS 使用 MP4Box）' : '检查音轨完整解码')
    const ffmpeg = await ensureFFmpeg()
    for (const [i, input] of muxInputs.entries()) {
      const probed = await audioTrackLabel(ffmpeg, input.path)
      input.title = input.lang && input.lang !== '—' ? `${input.lang} ${probed}` : probed
      if (!isDtsAudio(tracks[i]!) && !audioInfo[i]!.some(t => /^dts[cehlxy]$/.test(t.codec))) await validateAudio(ffmpeg, input.path)
    }
    emit('封装', 0.86, muxInputs.length > 1 ? `封装 ${muxInputs.length} 条音轨` : out)
    const muxProgress = (n: number, total: number) => emit('封装', 0.86 + 0.13 * (n / total), `封装 ${human(n)}/${human(total)}`)
    const partial = join(dir, `.${t.vid}.mux-partial${dts ? '.mp4' : '.mkv'}`)
    temps.add(partial)
    temps.add(`${partial}.timing.json`)
    try {
      if (dts) await mp4boxMux(mp4box, videoPath, muxInputs, partial, muxProgress)
      else if (muxInputs.length) await mkvmergeMux(mkvmerge, videoPath, muxInputs, partial, muxProgress)
      else await mkvmergeRemux(mkvmerge, videoPath, partial, muxProgress)
      if (!dts) await validateAudio(ffmpeg, partial)
      moveFileSync(partial, out)
      succeeded = true
      return out
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
    if (succeeded && process.env.GVS_KEEP_INTERMEDIATES !== '1') {
      await cleanupTemporaryFiles(temps)
      cleanupOutputCaches(dir)
    }
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

/** Remove leftover RE/mux cache folders from older runs sitting next to the finished file. */
export function cleanupOutputCaches(dir: string): void {
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return }
  for (const name of names) {
    if (!name.startsWith('.re-') && !name.startsWith('.mux-timing-')) continue
    const path = join(dir, name)
    try {
      if (statSync(path).isDirectory()) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch { /* finished file already in place */ }
  }
}

async function playYouku(cli: GwClient, cfg: FileConfig, t: DlTask, vid = t.vid): Promise<Record<string, unknown>> {
  // RE/relay reads the selected playlist; expanding every track here fetches
  // unused playlists and adds latency to every signed-URL refresh.
  const input: Record<string, unknown> = { vid, expand: '0', tier: t.quality ? 'multi' : 'single', nocache: '1' }
  return cli.invoke('youku', 'play', input, cli.extra(cfg, 'youku'))
}

function trackVid(t: DlTask, trackId: string, explicit?: string): string {
  if (explicit) return explicit
  const sep = trackId.indexOf('|')
  return sep >= 0 ? trackId.slice(0, sep) : t.vid
}



export function patchJob(jobs: Job[], e: JobEvt): void {
  const row = jobs.find((j) => j.id === e.id)
  if (!row) return
  row.status = e.status
  row.pct = e.pct
  row.log = e.log
  row.err = e.err
}
