import { mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import type { FileConfig } from './config.ts'
import type { GwClient } from './client.ts'
import { ffmpegDecryptCopy, ffmpegMux, ffmpegRemux, lookFFmpeg } from './ffmpeg.ts'
import { filename, folder, sourceTag } from './name.ts'
import type { Naming } from './name.ts'
import { writeEpisodeNFO, writeTvShowNFO } from './nfo.ts'
import {
  CdnDenied, appendURL, downloadProgress, pickDouyinURL, pickHongguo, pickURL, referer, speedCB, youkuAudioURLs,
  youkuStreamURLs,
} from './media.ts'
import type { RetryNote } from './media.ts'
import { asString, isObj } from './util.ts'
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
  /** Audio stream id (youku `audio_stream_type`); empty = platform default. */
  audio?: string
  group: string
  codec: string
  tmdbId: number
  nameDots: string
  year: number
  plot: string
}

export type JobEvt = { id: number; status: string; pct: number; log: string; err: string; done?: boolean }

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
    lastPct = pct
    emitEvt({ id, status, pct, log, err: '' })
  }
  const retryNote = (attempt: number, total: number, why: string) => {
    emitEvt({ id, status: '重试', pct: lastPct, log: `第 ${attempt}/${total} 次 · ${why}`, err: '' })
  }
  try {
    const kind = t.provider === 'hongguo' || t.provider === 'douyin' ? 'short' : 'show'
    const n: Naming = {
      kind,
      title: t.series || t.title,
      nameDots: t.nameDots,
      year: t.year,
      season: t.season,
      episode: t.episode,
      height: t.height,
      codec: t.codec || 'H264',
      source: sourceTag(t.provider),
      group: t.provider === 'douyin' ? '' : (t.group.trim() || cfg.releaseGroup),
      tmdbId: t.tmdbId,
      container: t.provider === 'douyin' ? 'mp4' : t.provider === 'hongguo' && cfg.hongguoFmt ? cfg.hongguoFmt : 'mkv',
    }
    const dir = t.provider === 'douyin' ? cfg.outDir : folder(n, cfg.outDir)
    mkdirSync(dir, { recursive: true })
    const out = join(dir, filename(n))
    const ffmpeg = t.provider === 'douyin' ? '' : lookFFmpeg(cfg.ffmpeg)
    if (t.provider !== 'douyin' && !ffmpeg) throw new Error('没有 ffmpeg。设置页填 ffmpeg.exe 完整路径，或安装后重开 TUI')
    emit('取链', 0.01, out.split(/[/\\]/).pop() ?? out)
    switch (t.provider) {
      case 'hongguo':
        await dlHongguo(cli, t, dir, out, ffmpeg, emit, retryNote)
        break
      case 'youku':
        await dlYouku(cli, cfg, t, dir, out, ffmpeg, emit, retryNote)
        break
      case 'tencent':
        await dlTencent(cli, cfg, t, dir, out, ffmpeg, emit, retryNote)
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
      writeTvShowNFO(t.season > 0 ? dirname(dir) : dir, t.series, t.plot, t.tmdbId)
      writeEpisodeNFO(out, t.title, t.season, t.episode, '')
    }
    emitEvt({ id, status: '完成', pct: 1, log: out, err: '', done: true })
  } catch (e) {
    emitEvt({ id, status: '失败', pct: 0, log: '', err: e instanceof Error ? e.message : String(e), done: true })
  }
}

async function dlHongguo(
  cli: GwClient, t: DlTask, dir: string, out: string, ffmpeg: string,
  emit: (s: string, p: number, l: string) => void,
  retryNote: RetryNote,
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
    } catch {
      key = ''
    }
  }
  const enc = join(dir, `.${t.vid}.enc.mp4`)
  emit('下载', 0.08, '')
  try {
    await downloadProgress(picked.cdn, enc, referer(t.provider), speedCB(emit, '下载', 0.08, 0.7), retryNote)
  } catch (e) {
    // 红果直链带 expire；403 说明链接过期，重新 resolve 一次再续传。
    if (!(e instanceof CdnDenied)) throw e
    emit('重取', 0.08, `CDN ${e.status}，重新取链后续传`)
    const again = pickHongguo(await cli.invoke('hongguo', 'resolve', { vid: t.vid, platform: 'ios' }), t.vid, t.quality)
    if (!again.cdn) throw new Error('红果重新取链失败')
    await downloadProgress(again.cdn, enc, referer(t.provider), speedCB(emit, '下载', 0.08, 0.7), retryNote)
  }
  const tmp = join(dir, `.${t.vid}.mp4`)
  emit('解密', 0.82, '')
  if (key) {
    await ffmpegDecryptCopy(ffmpeg, key, enc, tmp)
    try { unlinkSync(enc) } catch { /* keep */ }
  } else {
    renameSync(enc, tmp)
  }
  emit('封装', 0.92, out)
  try {
    await ffmpegRemux(ffmpeg, tmp, out)
  } catch {
    renameSync(tmp, out.slice(0, out.length - extname(out).length) + '.mp4')
    throw new Error('ffmpeg remux failed')
  }
  try { unlinkSync(tmp) } catch { /* keep */ }
}

async function dlTencent(
  cli: GwClient, cfg: FileConfig, t: DlTask, dir: string, out: string, ffmpeg: string,
  emit: (s: string, p: number, l: string) => void,
  retryNote: RetryNote,
): Promise<void> {
  emit('取链', 0.05, t.vid)
  const play = () => cli.invoke('tencent', 'play', { vid: t.vid, defn: t.quality || 'fhd' }, cli.extra(cfg, 'tencent'))
  let cdn = pickURL(await play())
  if (!cdn) throw new Error('腾讯没有 video.url')
  if (cdn.toLowerCase().includes('.m3u8')) throw new Error('HLS 下一期；当前片源是 m3u8')
  const raw = join(dir, `.${t.vid}.bin`)
  emit('下载', 0.1, '')
  try {
    await downloadProgress(cdn, raw, referer('tencent'), speedCB(emit, '下载', 0.1, 0.75), retryNote)
  } catch (e) {
    if (!(e instanceof CdnDenied)) throw e
    emit('重取', 0.1, `CDN ${e.status}，重新取链后续传`)
    cdn = pickURL(await play())
    if (!cdn) throw new Error('腾讯重新取链失败')
    await downloadProgress(cdn, raw, referer('tencent'), speedCB(emit, '下载', 0.1, 0.75), retryNote)
  }
  emit('封装', 0.9, out)
  await ffmpegRemux(ffmpeg, raw, out)
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
    await downloadProgress(cdn, out, referer('douyin'), speedCB(emit, '下载', 0.1, 0.85), retryNote)
  } catch (e) {
    if (!(e instanceof CdnDenied)) throw e
    emit('重取', 0.1, `CDN ${e.status}，重新解析后续传`)
    cdn = await resolve()
    await downloadProgress(cdn, out, referer('douyin'), speedCB(emit, '下载', 0.1, 0.85), retryNote)
  }
}

async function dlYouku(
  cli: GwClient, cfg: FileConfig, t: DlTask, dir: string, out: string, ffmpeg: string,
  emit: (s: string, p: number, l: string) => void,
  retryNote: RetryNote,
): Promise<void> {
  let data = await playYouku(cli, cfg, t)
  let urls = await youkuStreamURLs(data, t.quality)
  if (!urls.length) throw new Error('优酷 play 没有分片')
  const raw = join(dir, `.${t.vid}.fmp4`)
  const audioRaw = join(dir, `.${t.vid}.audio.fmp4`)
  const audioURLs = await youkuAudioURLs(data, t.audio ?? '')
  try {
    for (const [i, u] of urls.entries()) {
      emit('下载', 0.05 + 0.68 * i / urls.length, `${i + 1}/${urls.length}`)
      await appendURL(raw, u, referer('youku'))
    }
    if (audioURLs.length > 1) {
      for (const [i, u] of audioURLs.entries()) {
        emit('音轨', 0.73 + 0.05 * i / audioURLs.length, `${i + 1}/${audioURLs.length}`)
        await appendURL(audioRaw, u, referer('youku'))
      }
    }
  } catch (e) {
    // 分片链接带 expire，长片下到一半会 403：重新取一次 play 再续传一遍。
    const expired = e instanceof CdnDenied && (e.status === 403 || e.status === 410)
    if (!expired) throw e
    emit('重取', 0.05, `CDN ${e.status}，重新取链后重试`)
    data = await playYouku(cli, cfg, t)
    urls = await youkuStreamURLs(data, t.quality)
    if (!urls.length) throw new Error('优酷重新取链后仍没有分片')
    for (const [i, u] of urls.entries()) {
      emit('下载', 0.05 + 0.68 * i / urls.length, `重试 ${i + 1}/${urls.length}`)
      await appendURL(raw, u, referer('youku'))
    }
  }

  let key = ''
  if (isObj(data.drm)) key = asString(data.drm.content_key_hex)
  let tmp = join(dir, `.${t.vid}.mp4`)
  emit('解密', 0.8, '')
  if (key) {
    try {
      await ffmpegDecryptCopy(ffmpeg, key, raw, tmp)
      try { unlinkSync(raw) } catch { /* keep */ }
    } catch {
      emit('解密', 0.8, 'ffmpeg 解密失败，尝试直接封装')
      tmp = raw
    }
  } else {
    tmp = raw
  }
  let audioTmp = ''
  if (audioURLs.length > 1) {
    audioTmp = key ? join(dir, `.${t.vid}.audio.mp4`) : audioRaw
    if (key) {
      try {
        await ffmpegDecryptCopy(ffmpeg, key, audioRaw, audioTmp)
      } catch {
        audioTmp = audioRaw
      }
    }
  }
  emit('封装', 0.92, out)
  if (audioTmp) await ffmpegMux(ffmpeg, tmp, audioTmp, out)
  else await ffmpegRemux(ffmpeg, tmp, out)
  try { unlinkSync(tmp) } catch { /* keep */ }
  if (audioTmp) {
    try { unlinkSync(audioTmp) } catch { /* keep */ }
  }
  if (tmp !== raw) {
    try { unlinkSync(raw) } catch { /* keep */ }
  }
}

async function playYouku(cli: GwClient, cfg: FileConfig, t: DlTask): Promise<Record<string, unknown>> {
  const input: Record<string, unknown> = { vid: t.vid, expand: '1', tier: t.quality ? 'multi' : 'single' }
  return cli.invoke('youku', 'play', input, cli.extra(cfg, 'youku'))
}



export function patchJob(jobs: Job[], e: JobEvt): void {
  const row = jobs.find((j) => j.id === e.id)
  if (!row) return
  row.status = e.status
  row.pct = e.pct
  if (e.log) row.log = e.log
  row.err = e.err
}
