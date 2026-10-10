import { closeSync, linkSync, openSync, unlinkSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { ActualVersion, MediaSpecs } from './actual-version.ts'
import { probeFinishedMedia, type ProbeAudioOptions } from './gvs-record.ts'
import { completedFilename, sanitizePath, type Naming } from './name.ts'
import { asString, isObj } from './util.ts'

/** Only non-secret identifiers persist with a task; never a URL or raw play payload. */
export type NamingEvidence = {
  marker?: 'HQ' | 'MAXPLUS' | 'EDR'
  stream?: string
  evidence?: 'stream_url' | 'format_url' | 'video_metadata' | 'format_filename' | 'download_plan'
  muxAudio?: ProbeAudioOptions['muxAudio']
}

export function usesMeasuredNaming(task: { provider: string; namingVersion?: number }): boolean {
  return task.namingVersion === 1 && ['youku', 'tencent', 'iq', 'iqcn'].includes(task.provider)
}

export function youkuNamingEvidence(data: Record<string, unknown>, downloadedURL: string): NamingEvidence {
  if (!downloadedURL) return {}
  const rows = (Array.isArray(data.streams) ? data.streams.filter(isObj) : [])
    .filter(s => asString(s.media_type).toLowerCase() !== 'audio' && (s.playlist_url === downloadedURL || s.url === downloadedURL))
  if (isObj(data.video) && (data.video.playlist_url === downloadedURL || data.video.url === downloadedURL)) rows.push(data.video)
  const streams = rows.map(s => asString(s.stream_type) || asString(s.quality)).filter(Boolean)
  // A fallback video object without a stream ID supplies no identity. Conflicting IDs are ambiguous.
  if (!streams.length || new Set(streams).size !== 1) return {}
  const stream = streams[0]!
  if (!/^[\w.-]{1,96}$/.test(stream)) return {}
  return { stream, evidence: 'stream_url', ...(/(?:^|_)hq(?:_|$)/i.test(stream) ? { marker: 'HQ' as const } : {}) }
}

export function tencentNamingEvidence(record: ActualVersion): NamingEvidence {
  const stream = record.actual?.stream
  if (!stream || record.evidence === 'ambiguous' || record.evidence === 'unknown') return {}
  return { stream, evidence: record.evidence, ...(stream.toLowerCase() === 'maxplus' ? { marker: 'MAXPLUS' as const } : {}) }
}

/** Bind IQCN's EDR label to the video in the returned download plan, not the requested tier. */
export function iqcnNamingEvidence(plan: Record<string, unknown>): NamingEvidence {
  if (!isObj(plan.video)) return {}
  const video = plan.video
  const vid = asString(video.vid)
  const keys = ['bid', 'br', 'fr'] as const
  const selectors = keys.map(key => asString(video[key]))
  if (!/^[A-Za-z0-9]{1,96}$/.test(vid) || !selectors.every(value => /^[1-9]\d{0,8}$/.test(value))) return {}
  const stream = [...selectors, vid].join('|')
  const rows = (Array.isArray(plan.formats) ? plan.formats.filter(isObj) : [])
    .filter(row => row.vid === vid || asString(row.id).split('|')[3] === vid)
  if (!rows.length) return {}
  // The same BID/bitrate/fps can describe SDR, EDR, HDR and DV. Require the
  // returned video ID and reject conflicting IDs/selectors even in one row.
  if (rows.some(row => {
    const id = asString(row.id), parts = id.split('|')
    return (row.vid != null && asString(row.vid) !== vid) || (id && id !== stream)
      || keys.some((key, index) => asString(row[key] ?? parts[index]) !== selectors[index])
  })) return {}
  const edr = rows.map(row => {
    // Current source codes: 4 = EDR, 8 = EDR 10bit. Legacy gateways may
    // return only an explicit name; never infer EDR from 4K or high bitrate.
    if (row.dynamic_range_code != null) return ['4', '8'].includes(asString(row.dynamic_range_code).trim())
    return /(?:^|[^a-z0-9])edr(?:$|[^a-z0-9])/i.test(asString(row.name))
  })
  if (new Set(edr).size !== 1) return {}
  return { stream, evidence: 'download_plan', ...(edr[0] ? { marker: 'EDR' as const } : {}) }
}

/** Claim a provisional name before muxing; retries/new tasks never replace an existing library file. */
export function reserveOutputPath(preferred: string): string {
  const ext = extname(preferred), stem = basename(preferred, ext)
  for (let i = 0; i < 10_000; i++) {
    const suffix = `.download-${i}${ext}`
    let fitted = ''
    if (i) for (const ch of stem) {
      if (Buffer.byteLength(fitted + ch + suffix, 'utf8') > 240) break
      fitted += ch
    }
    const path = i ? join(dirname(preferred), fitted + suffix) : preferred
    try { closeSync(openSync(path, 'wx', 0o644)); return path } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('无法分配下载文件名')
}

/** Atomic no-clobber publication in the same directory, without copying a large completed video. */
export function renameCompletedFile(path: string, file: string): string {
  if (!file || file !== basename(file) || file !== sanitizePath(file) || !extname(file)) throw new Error('无效的文件名')
  const target = join(dirname(path), file)
  if (target === path) return path
  linkSync(path, target)
  try { unlinkSync(path) } catch (error) {
    unlinkSync(target)
    throw error
  }
  return target
}

export async function finalizeCompletedName(path: string, n: Naming, evidence: NamingEvidence = {}, signal?: AbortSignal,
  probe = probeFinishedMedia): Promise<{ output: string; media: MediaSpecs; note?: string }> {
  let media: MediaSpecs
  try { media = await probe(path, signal, { muxAudio: evidence.muxAudio }) } catch {
    signal?.throwIfAborted()
    media = { status: 'unavailable' }
  }
  signal?.throwIfAborted()
  if (media.status !== 'probed' || !media.width || !media.height || !media.codec || media.codec === 'unknown') {
    return { output: path, media, note: '无法读取实际视频规格，自动命名已跳过，保留原文件名' }
  }
  const note = media.audio?.status !== 'none' && (!media.audio?.codec || !media.audio.channels)
    ? '默认音轨规格未能确认，文件名已省略音频信息' : undefined
  try {
    const file = completedFilename({ ...n, container: extname(path).slice(1) || n.container }, media, evidence.marker)
    return { output: renameCompletedFile(path, file), media, note }
  } catch (error) {
    return { output: path, media, note: (error as NodeJS.ErrnoException).code === 'EEXIST'
      ? '目标文件名已存在，保留本次下载的原文件名' : '自动命名未完成，保留原文件名' }
  }
}
