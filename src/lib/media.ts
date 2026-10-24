import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { asString, combinedSignal, human, isObj, sleep } from './util.ts'
import { mkvmergeRemux, mkvmergeTrackFiles } from './mkvmerge.ts'
import { ensureFFmpeg, ensureM3u8dl, ensureMkvmerge, ensurePackager } from './tools.ts'
import { createHlsRelay, type RelayEvent } from './hls-relay.ts'
import { normalizeHttpProxy } from './proxy.ts'
import { moveFileSync } from './file-move.ts'
import { runLog } from './runlog.ts'
import { assertCencMp4Output, isMpegTsFile } from './media-output.ts'
import { removeScratch, resumeScratchDir, scratchDir, scratchDirIn } from './scratch.ts'
import { tencentActualVersion, type ActualVersion } from './actual-version.ts'
import { tencentCaption } from './tencent-quality-selection.ts'
import { DownloaderCompatibilityError, hasUnsupportedDownloaderFormat } from './downloader-error.ts'

/** A CDN refused us (403/410 …) — usually the signed URL expired mid-flight. */
export class CdnDenied extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`cdn ${status}`)
    this.name = 'CdnDenied'
  }
}

const RETRY_STATUS = new Set([403, 408, 410, 425, 429, 500, 502, 503, 504])
const MAX_ATTEMPTS = 5

export type RetryNote = (attempt: number, total: number, why: string) => void
export type MediaFetch = (src: string, init: RequestInit) => Promise<Response>

export function headersFor(ref: string, from = 0, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    // 有些 CDN 只认完整的浏览器头，缺 Accept 也会给 403。
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  }
  if (ref) headers.Referer = ref
  if (extra) {
    const merged = new Headers(headers)
    for (const [name, value] of Object.entries(extra)) merged.set(name, value)
    if (from > 0) merged.set('Range', `bytes=${from}-`)
    return Object.fromEntries(merged.entries())
  }
  if (from > 0) headers.Range = `bytes=${from}-`
  return headers
}

/**
 * GET a CDN URL with retries and byte-range resume. CDN links expire (403/410)
 * or hiccup (5xx, socket resets) mid-download, and hammering the same URL
 * immediately rarely helps, so back off and report each attempt upwards.
 */
async function openStream(
  src: string,
  ref: string,
  from: number,
  note?: RetryNote,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  fetcher: MediaFetch = fetch,
): Promise<{ res: Response; body: ReadableStream<Uint8Array> | null }> {
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    signal?.throwIfAborted()
    try {
      const res = await fetcher(src, { headers: headersFor(ref, from, headers), signal })
      if (res.ok || res.status === 206) return { res, body: res.body }
      if (RESPECT_AFTER.has(res.status)) {
        const wait = Number(res.headers.get('retry-after') ?? 0) * 1000
        if (wait > 0 && attempt < MAX_ATTEMPTS) await sleep(Math.min(wait, 10_000), signal)
      }
      if (!RETRY_STATUS.has(res.status)) throw new CdnDenied(res.status, src)
      lastErr = new CdnDenied(res.status, src)
      note?.(attempt, MAX_ATTEMPTS, `HTTP ${res.status}`)
    } catch (e) {
      signal?.throwIfAborted()
      if (e instanceof CdnDenied && e.status !== 403 && e.status !== 410) throw e
      lastErr = e
      note?.(attempt, MAX_ATTEMPTS, e instanceof Error ? e.message : String(e))
    }
    if (attempt < MAX_ATTEMPTS) await sleep(Math.min(500 * 2 ** (attempt - 1), 8000), signal)
  }
  throw lastErr instanceof Error ? lastErr : new Error('cdn unreachable')
}

const RESPECT_AFTER = new Set([429, 503])

export function referer(p: string): string {
  switch (p) {
    case 'tencent': return 'https://v.qq.com/'
    case 'youku': return 'https://www.youku.com/'
    case 'douyin': return 'https://www.douyin.com/'
    case 'iqcn': return 'https://www.iqiyi.com/'
    case 'huangguo': return 'https://huangguoai.com/'
    default: return ''
  }
}

export function hongguoItem(data: Record<string, unknown>, vid: string): Record<string, unknown> {
  if (isObj(data.videos)) {
    const hit = data.videos[vid]
    if (isObj(hit)) return hit
    return { err: "红果未返回所请求的分集" }
  }
  if (isObj(data.video)) return data.video
  return data
}

export function pickHongguo(data: Record<string, unknown>, vid: string, want: string): { cdn: string; key: string; spade: string; why: string } {
  const item = hongguoItem(data, vid)
  const why = asString(item.err)
  if (why) return { cdn: '', key: '', spade: '', why }
  const streams = Array.isArray(item.streams) ? item.streams.filter(isObj).filter(s => asString(s.url)) : []
  const wantQ = want.toLowerCase().trim()
  // New variants own their key, including an explicitly empty key for clear media.
  const variants = streams.filter(s => Object.hasOwn(s, 'key'))
  if (variants.length) {
    const chosen = wantQ ? variants.find(s => asString(s.id).toLowerCase() === wantQ || asString(s.quality).toLowerCase() === wantQ) : variants[0]
    if (!chosen) throw new Error('所选红果画质已不可用，请重新选择')
    const key = asString(chosen.key)
    if (key && !/^[a-f\d]{32}$/i.test(key)) throw new Error('红果未返回有效解密密钥')
    return { cdn: asString(chosen.url), key, spade: '', why: '' }
  }
  const spade = asString(item.template) || asString(item.spade)
  const key = asString(item.key)
  if (key && !/^[a-f\d]{32}$/i.test(key)) throw new Error('红果未返回有效解密密钥')
  if (asString(item.url)) {
    if (wantQ) throw new Error('网关未返回所选红果画质，请更新网关并重新选择')
    return { cdn: asString(item.url), key, spade, why }
  }
  const chosen = wantQ ? streams.find(s => asString(s.quality).toLowerCase() === wantQ) : streams[0]
  if (wantQ && !chosen) throw new Error('所选红果画质已不可用，请重新选择')
  return { cdn: chosen ? asString(chosen.url) : '', key, spade, why }

}

export function pickURL(data: Record<string, unknown>): string {
  if (isObj(data.video)) {
    const u = asString(data.video.url) || asString(data.video.playlist_url)
    if (u) return u
  }
  const top = asString(data.url)
  if (top) return top
  // Tencent TV / catalog play may only put playlist on formats[] rows.
  if (Array.isArray(data.formats)) {
    for (const raw of data.formats) {
      if (!isObj(raw)) continue
      const u = asString(raw.url) || asString(raw.playlist_url)
      if (u) return u
    }
  }
  return ''
}


export type TencentDownloadPickOpts = {
  stream?: string
  caption?: string
  formatId?: string
  persona?: string
}

/**
 * Pick a downloadable Tencent URL from play(), matching the selected normal
 * quality/caption format before falling back to the default video URL.
 */
export function pickTencentDownloadURL(
  data: Record<string, unknown>,
  opts: TencentDownloadPickOpts = {},
): string {
  return pickTencentDownload(data, opts).url
}

/** Same compatible URL selection, with provenance kept alongside the chosen address. */
export function pickTencentDownload(
  data: Record<string, unknown>, opts: TencentDownloadPickOpts = {}, vid = '', refreshes = 0,
): { url: string; version: ActualVersion } {
  const finish = (url: string, source: ActualVersion['addressSource']) => ({
    url, version: tencentActualVersion(data, url, source, {
      stream: opts.stream, caption: opts.caption, formatId: opts.formatId, persona: opts.persona,
    }, vid, refreshes),
  })
  const stream = (opts.stream || '').trim().toLowerCase()
  const wantCap = (opts.caption || '').trim().toLowerCase()
  const wantId = (opts.formatId || '').trim()
  const formats = Array.isArray(data.formats) ? data.formats : []
  const hasHint = !!(stream || wantCap || wantId)
  if (hasHint) {
    let best = ''
    let bestScore = -1
    for (const raw of formats) {
      if (!isObj(raw)) continue
      const u = asString(raw.url) || asString(raw.playlist_url)
      if (!u) continue
      let score = 0
      const name = asString(raw.name).toLowerCase()
      const defn = asString(raw.defn).toLowerCase()
      const cap = (asString(raw.caption_probe) || asString(raw.caption)).toLowerCase()
      const id = asString(raw.id)
      // A caption match alone must never select a different requested format.
      if (wantId && id !== wantId) continue
      if (stream && name !== stream && defn !== stream) continue
      if (wantCap && cap && tencentCaption(cap) !== tencentCaption(wantCap)) continue
      const personas = [asString(raw.persona), ...(Array.isArray(raw.personas) ? raw.personas.map(asString) : [])]
      if (opts.persona && personas.some(Boolean) && !personas.includes(opts.persona)) continue
      if (wantId && id && id === wantId) score += 10
      if (stream && (name === stream || defn === stream)) score += 5
      if (wantCap && cap === wantCap) score += 3
      if (score > bestScore) {
        bestScore = score
        best = u
      }
    }
    if (best && bestScore > 0) return finish(best, 'format')
  }

  // A selected format must win over the gateway's default video URL. The
  // default URL can point at a different ladder (often AAC audio), while the
  // formats catalog carries the requested caption/quality variant.
  if (isObj(data.video)) {
    const u = asString(data.video.url) || asString(data.video.playlist_url)
    if (u) return finish(u, 'default')
  }
  const top = asString(data.url) || asString(data.playlist_url)
  if (top) return finish(top, 'default')

  // Last resort: pickURL (video already checked; may hit first formats[] url).
  return finish(pickURL(data), 'other')
}

/**
 * afterQuality verify for Tencent: play often returns formats[] / has_url without
 * a top-level video.url. Treat that as success unless network_error / hard error.
 */
export function tencentPlayProbeOk(data: Record<string, unknown>): {
  ok: boolean
  via?: string
  reason?: string
} {
  const network =
    data.network_error === true ||
    data.network_error === 1 ||
    asString(data.network_error).toLowerCase() === 'true'
  const err = asString(data.error)
  const em = asString(data.em)
  if (network) {
    return {
      ok: false,
      reason: friendlyTencentPlayError(err || em || 'TV play request failed', true),
    }
  }
  if (err) {
    return { ok: false, reason: friendlyTencentPlayError(err, false) }
  }
  // Episode entitlement lock: fail even if leftover formats[] exist.
  if (/^93(\.[0-9]+)?$/.test(em) || em.startsWith('93.') || (/限制播放/.test(em) && !pickURL(data))) {
    return { ok: false, reason: friendlyTencentPlayError(em || '限制播放', false) }
  }

  if (pickURL(data)) return { ok: true, via: 'url' }
  if (data.has_url === true || asString(data.has_url) === 'true' || data.has_url === 1) {
    return { ok: true, via: 'has_url' }
  }
  if (Array.isArray(data.formats) && data.formats.length > 0) {
    // Soft em (empty / info) with a formats catalog is still a usable probe.
    if (em && /fail|error|拒绝|不可用|超时|timeout|denied/i.test(em) && !pickURL(data)) {
      return { ok: false, reason: friendlyTencentPlayError(em, false) }
    }
    return { ok: true, via: 'formats' }
  }
  if (Array.isArray(data.videos)) {
    for (const v of data.videos) {
      if (v && typeof v === 'object' && pickURL(v as Record<string, unknown>)) {
        return { ok: true, via: 'videos' }
      }
    }
  }
  if (em) return { ok: false, reason: friendlyTencentPlayError(em, false) }
  return { ok: false, reason: '选定画质没有返回可用视频地址' }
}

function friendlyTencentPlayError(raw: string, network: boolean): string {
  const s = raw.trim()
  if (!s) return network ? '腾讯取流网络错误' : '腾讯取流失败'
  if (/^93(\.[0-9]+)?$/.test(s) || s.startsWith('93.') || /限制播放/.test(s) || /\bem\s*=\s*93\b/i.test(s)) {
    return '该集触发权益风控(em=93)，已停止本次请求；恢复时间未知，请按官方提示处理，勿反复重试。'
  }
  if (/TV play request failed/i.test(s)) return '腾讯 TV 取流请求失败'
  if (/network/i.test(s)) return `腾讯取流网络错误：${s}`
  return s
}

export function pickDouyinURL(data: Record<string, unknown>): string {
  const media = Array.isArray(data.media) ? data.media : []
  let fallback = ''
  for (const it of media) {
    if (!isObj(it)) continue
    const u = asString(it.url)
    if (!u) continue
    if (asString(it.type) === 'video') return u
    if (!fallback) fallback = u
  }
  return fallback
}

export type TransferProgress = { bytes: number; bytesPerSecond?: number }
export type SpeedInfo = { phase?: PlaylistPhase; log?: string; segments?: { done: number; total: number }; transfer?: TransferProgress }

/** Measure recent byte growth, excluding cached fragments present on resume. */
export function transferSpeed(now: () => number = Date.now): (bytes: number) => TransferProgress {
  let samples: Array<{ at: number; bytes: number }> = []
  return bytes => {
    const at = now()
    const last = samples.at(-1)
    if (last && (bytes < last.bytes || at < last.at)) samples = []
    if (!samples.length || at > samples.at(-1)!.at) samples.push({ at, bytes })
    while (samples.length > 2 && samples[1]!.at <= at - 2000) samples.shift()
    const first = samples[0]!
    return { bytes, ...(at - first.at >= 250 ? { bytesPerSecond: Math.max(0, (bytes - first.bytes) * 1000 / (at - first.at)) } : {}) }
  }
}

/** Byte totals are file sizes. A total of 1 is the HLS 0–1 ratio, not 1 byte. */
export function formatSpeed(n: number, total: number, elapsedSec: number, info?: SpeedInfo): string {
  if (info?.log) return info.log
  if (info?.phase === 'merge' || info?.phase === 'decrypt') return info.phase === 'merge' ? '合并' : '解密'
  if (total > 1) {
    const spd = elapsedSec > 0.2 ? n / elapsedSec : 0
    return `${human(n)}/${human(total)}  ${human(spd)}/s`
  }
  const segments = info?.segments
  if (info?.transfer) {
    const rate = info.transfer.bytesPerSecond
    return [segments && segments.total > 0 ? `${segments.done}/${segments.total} 段` : '',
      `已下载 ${human(info.transfer.bytes)}`, rate === undefined ? '正在测速' : `约 ${human(rate)}/s`].filter(Boolean).join(' · ')
  }
  if (info?.phase === 'download' && !segments) return '正在测速'
  if (segments && segments.total > 0) return `${segments.done}/${segments.total} 段 · 速度未知`
  return '速度未知'
}

export function speedCB(
  emit: (status: string, pct: number, log: string) => void,
  status: string,
  base: number,
  span: number,
): (n: number, total: number, info?: SpeedInfo) => void {
  const start = Date.now()
  let last = 0
  return (n, total, info) => {
    const now = Date.now()
    if (last && now - last < 250 && (total <= 0 || n < total)) return
    last = now
    let p = base
    if (total > 0) p = base + span * n / total
    emit(status, p, formatSpeed(n, total, (now - start) / 1000, info))
  }
}

async function cdnResponse(src: string, ref: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  const { res } = await openStream(src, ref, 0, undefined, headers, signal)
  return res
}

/** Below this size a single connection is already faster than splitting. */
const PARALLEL_MIN_BYTES = 4 << 20
/** Cap on buffered segment bytes while pulling ordered segments. */
const SEGMENT_BUFFER_BYTES = 64 << 20

type RangeProbe = { total: number; ranges: boolean }

/** Ask for one byte to learn the size and whether the CDN honours `Range`. */
async function probeRange(src: string, ref: string, headers?: Record<string, string>, signal?: AbortSignal, fetcher: MediaFetch = fetch): Promise<RangeProbe> {
  try {
    const requestHeaders = new Headers(headersFor(ref, 0, headers))
    requestHeaders.set('Range', 'bytes=0-0')
    const res = await fetcher(src, { headers: requestHeaders, signal })
    const cr = res.headers.get('content-range') ?? ''
    const total = Number(cr.split('/')[1] ?? 0)
    await res.body?.cancel().catch(() => {})
    if (res.status === 206 && total > 0) return { total, ranges: true }
    const len = Number(res.headers.get('content-length') ?? 0)
    return { total: len, ranges: false }
  } catch (e) {
    // A stop is not a probe failure: falling back to the single-connection
    // path here would restart the whole transfer instead of resuming.
    if (signal?.aborted) throw signal.reason ?? e
    return { total: 0, ranges: false }
  }
}

/**
 * Byte-range resume is only safe against the exact same bytes. A retry after a
 * CDN denial re-resolves the URL and may pair a different rendition with a
 * different key, and the offset into `dest` would then splice two streams. So
 * every partial transfer records an identity hash of (CDN path + cipher/key)
 * and is discarded when that identity changed. The key is hashed, never
 * stored, so a work folder left behind by a failure leaks nothing.
 */
export function sourceIdentity(src: string, cipher?: HlsCipher, key?: string): string {
  let path = src
  try {
    const url = new URL(src)
    path = `${url.origin}${url.pathname}`
  } catch { /* not an absolute URL: use it verbatim */ }
  const proof = key ? `key:${key}` : cipher ? `${cipher.method}:${cipher.key}:${cipher.iv}` : ''
  return createHash('sha256').update(`${path}|${proof}`).digest('hex').slice(0, 32)
}

/**
 * `.partN` chunks are only reusable when they were split the same way. The span
 * depends on `threads` and the total size, so a changed thread count (or a new
 * CDN URL for different bytes) would silently splice two different streams.
 * The sidecar records all three; a mismatch drops the completed chunks.
 */
type PartPlan = { threads: number; total: number }
export type PartPlanRead = { fingerprint: string | undefined; headerTotal: number }

function partsPath(dest: string): string {
  return `${dest}.parts.json`
}

function readPartsPlan(dest: string): PartPlanRead {
  let fingerprint: string | undefined
  let headerTotal = 0
  try {
    const raw = JSON.parse(readFileSync(partsPath(dest), 'utf8')) as Record<string, unknown>
    const plan = raw.plan && typeof raw.plan === 'object' ? raw.plan as PartPlan : raw as unknown as PartPlan
    const head = Number(raw.headerTotal ?? 0)
    if (Number.isFinite(head) && head > 0) headerTotal = head
    if (Number.isFinite(plan?.threads) && Number.isFinite(plan?.total)) {
      fingerprint = `${plan.threads}:${plan.total}:${String(raw.identity ?? '')}`
    }
  } catch { /* first run or a torn sidecar */ }
  return { fingerprint, headerTotal }
}

function writePartsPlan(dest: string, plan: PartPlan, headerTotal: number, identity: string | undefined): void {
  try { writeFileSync(partsPath(dest), `${JSON.stringify({ version: 1, plan, headerTotal, identity })}\n`) } catch { /* resume is best effort */ }
}

function dropParts(dest: string, parts: number): void {
  for (let i = 0; i < parts; i++) {
    try { unlinkSync(partPath(dest, i)) } catch { /* already gone */ }
  }
  try { unlinkSync(partsPath(dest)) } catch { /* already gone */ }
}

function resumePath(dest: string): string {
  return `${dest}.resume.json`
}

/** Bytes already on disk for `dest`, but only when they belong to this source. */
function resumableBytes(dest: string, identity: string | undefined): number {
  let have = 0
  try { have = statSync(dest).size } catch { return 0 }
  if (!have) return 0
  // No identity to compare (older callers) keeps the historical behaviour.
  if (!identity) return have
  let saved = ''
  try {
    saved = String((JSON.parse(readFileSync(resumePath(dest), 'utf8')) as Record<string, unknown>).identity ?? '')
  } catch { /* no sidecar: the bytes cannot be attributed */ }
  if (saved === identity) return have
  // Unknown or foreign bytes must never be spliced into this download.
  try { unlinkSync(dest) } catch { /* the append below would still be wrong */ }
  try { unlinkSync(resumePath(dest)) } catch { /* already gone */ }
  return 0
}

function writeResumeState(dest: string, identity: string | undefined, have: number): void {
  if (!identity) return
  try { writeFileSync(resumePath(dest), `${JSON.stringify({ version: 1, identity, have })}\n`) } catch { /* resume is best effort */ }
}

function clearResumeState(dest: string): void {
  try { unlinkSync(resumePath(dest)) } catch { /* already gone */ }
}

/** Stable, filesystem-safe folder name for one track inside the job work dir. */
export function workTagOf(explicit: string | undefined, dest: string): string {
  // Track paths can come from persisted jobs created on another OS.
  const raw = explicit || basename(dest.replace(/\\/g, '/'))
  return raw.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'track'
}

/** Empty a deterministic scratch parent so retries never accumulate folders. */
function removeStaleChildren(parent: string): void {
  let names: string[] = []
  try { names = readdirSync(parent) } catch { return }
  for (const name of names) {
    try { rmSync(join(parent, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* in use */ }
  }
}

function partPath(dest: string, index: number): string {
  return `${dest}.part${index}`
}

function partSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function writeChunk(path: string, buf: Buffer, append: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(path, { flags: append ? 'a' : 'w' })
    file.end(buf, () => file.close((err) => (err ? reject(err) : resolve())))
  })
}

/**
 * Multi-connection download: split the file into `threads` byte ranges, fetch
 * them in parallel, and keep each chunk in `<dest>.partN` so an interrupted run
 * resumes from the completed chunks instead of restarting. Falls back to a
 * single stream when the CDN ignores `Range`.
 */
async function downloadParallel(
  src: string,
  dest: string,
  ref: string,
  total: number,
  threads: number,
  cb?: (n: number, total: number) => void,
  note?: RetryNote,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  identity?: string,
  fetcher: MediaFetch = fetch,
): Promise<void> {
  const parts = Math.max(2, threads)
  const span = Math.ceil(total / parts)
  const sizes = new Array<number>(parts).fill(0)
  const ends = new Array<number>(parts).fill(0)
  // A different split (threads / byte count / source identity) means the chunks
  // on disk belong to another download; reusing them would splice two streams.
  const current = readPartsPlan(dest)
  const reusable = current.fingerprint === `${parts}:${total}:${identity ?? ''}`
  if (!reusable) {
    if (current.fingerprint) note?.(1, MAX_ATTEMPTS, '分片参数已变化，丢弃旧的临时分片')
    dropParts(dest, Math.max(parts, 16))
  }
  let done = 0
  for (let i = 0; i < parts; i++) {
    ends[i] = Math.min(total, (i + 1) * span)
    sizes[i] = Math.min(partSize(partPath(dest, i)), ends[i] - i * span)
    done += sizes[i]
  }
  writePartsPlan(dest, { threads: parts, total }, total, identity)
  cb?.(done, total)

  await Promise.all(
    Array.from({ length: parts }, async (_, i) => {
      const start = i * span
      const end = ends[i] - 1
      const path = partPath(dest, i)
      while (sizes[i] < end - start + 1) {
        signal?.throwIfAborted()
        const from = start + sizes[i]
        let attempt = 0
        for (;;) {
          attempt++
          try {
            const requestHeaders = new Headers(headersFor(ref, from, headers))
            requestHeaders.set('Range', `bytes=${from}-${end}`)
            const res = await fetcher(src, { headers: requestHeaders, signal })
            if (res.status !== 206) {
              await res.body?.cancel().catch(() => {})
              throw new Error('cdn ignored range')
            }
            if (!res.body) throw new Error('cdn empty body')
            const node = Readable.fromWeb(res.body as unknown as NodeWebReadableStream)
            const file = createWriteStream(path, { flags: sizes[i] > 0 ? 'a' : 'w' })
            node.on('data', (chunk: Buffer | Uint8Array) => {
              sizes[i] += chunk.length
              done += chunk.length
              cb?.(done, total)
            })
            await pipeline(node, file, { signal })
            break
          } catch (e) {
            // Stopping must not be reported as a CDN retry, and must not fall
            // through to the merge step below.
            if (signal?.aborted) throw signal.reason ?? e
            if (attempt >= MAX_ATTEMPTS) throw e
            note?.(attempt, MAX_ATTEMPTS, `分片 ${i + 1}/${parts} 续传`)
            await sleep(Math.min(800 * 2 ** (attempt - 1), 6000), signal)
          }
        }
      }
    }),
  )

  // Assigning every chunk before truncating `dest` keeps the blob on disk if we
  // are stopped in between: the parts are still there for the next resume.
  const out = createWriteStream(dest, { flags: 'w' })
  for (let i = 0; i < parts; i++) {
    const path = partPath(dest, i)
    if (partSize(path) === 0) continue
    // Stream each part in by hand: pipeline(..., { end: false }) in a loop
    // piles one 'error' listener onto the same write stream per part.
    const rs = createReadStream(path, { highWaterMark: 1 << 20 })
    for await (const chunk of rs) {
      if (!out.write(chunk as Buffer)) await once(out, 'drain')
    }
    try { unlinkSync(path) } catch { /* keep */ }
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
  try { unlinkSync(partsPath(dest)) } catch { /* already gone */ }
  cb?.(total, total)
}

function pickREOutput(dir: string, muxed = false): string {
  const skip: Record<string, true> = { '.json': true, '.txt': true, '.log': true, '.m3u8': true, '.mpd': true }
  let best = ''
  let bestN = 0
  for (const name of readdirSync(dir)) {
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
    if (muxed && ext !== '.mkv') continue
    if (skip[ext]) continue
    const p = join(dir, name)
    try {
      const st = statSync(p)
      if (st.isFile() && st.size > bestN) {
        best = p
        bestN = st.size
      }
    } catch { /* skip */ }
  }
  return best
}

export function cleanRELog(s: string): string {
  return s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\b[a-f\d]{32}(?::[a-f\d]{32})?\b/gi, '[已隐藏]')
    .split(/\r?\n|\r/)
    .filter((line) => !/输出.*重定向|[Oo]utput.*redirected/i.test(line))
    .map((line) => line.replace(/https?:\/\/[^\s"<>]+/g, '[媒体地址]'))
    .join('\n')
    .trim()
}

/** Percentages may be split across pipe chunks or repeated by terminal redraws. */
export function reProgress(cb?: (n: number, total: number, segments?: { done: number; total: number }) => void): (chunk: string) => void {
  let tail = ''
  let last = 0
  return (chunk) => {
    const text = (tail + chunk).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // Only RE download rows contain a completed/total segment count followed
    // by a percentage. URLs (e.g. vid=1234%3D) and decrypt/parse logs do not.
    for (const match of text.matchAll(/\b(\d+)\s*\/\s*(\d+)\s+(\d{1,3}(?:\.\d+)?)\s*%(?=\s|$|[│┃])/g)) {
      const done = Number(match[1])
      const total = Number(match[2])
      const value = Number(match[3])
      if (!total || done > total || value > 100) continue
      const pct = Math.min(0.99, done / total)
      if (pct > last) { last = pct; cb?.(pct, 1, { done, total }) }
    }
    tail = text.split(/[\r\n]/).at(-1)?.slice(-2048) ?? ''
  }
}

export type PlaylistPhase = 'download' | 'merge' | 'decrypt'
export type PlaylistProgress = SpeedInfo & { phase: PlaylistPhase }
export type ProgressCB = (n: number, total: number, info?: PlaylistProgress) => void

/** RE's noninteractive console emits no intermediate progress. Count finished
 * fragment files against its selected-stream metadata; in-flight .tmp files
 * never count, and merge/decrypt phases continue using their byte monitors. */
export function reDownloadedSegments(dir: string, listedTotal?: number): { done: number; total: number; bytes: number } | undefined {
  const root = join(dir, 'download')
  let total = 0
  try {
    const streams: unknown = JSON.parse(readFileSync(join(root, 'meta_selected.json'), 'utf8').replace(/^\uFEFF/, ''))
    for (const stream of Array.isArray(streams) ? streams.filter(isObj) : []) {
      const playlist = isObj(stream.Playlist) ? stream.Playlist : {}
      for (const part of Array.isArray(playlist.MediaParts) ? playlist.MediaParts.filter(isObj) : [])
        total += Array.isArray(part.MediaSegments) ? part.MediaSegments.length : 0
      if (isObj(playlist.MediaInit)) total++
    }
  } catch { /* metadata appears only after parsing; content-key runs disable it */ }
  // --write-meta-json false (content keys must not be written to disk) leaves
  // only RE's console listing of the selected streams as the segment total.
  if (!total) total = listedTotal ?? 0
  if (!total) return
  try {
    let done = 0, bytes = 0
    for (const name of readdirSync(root, { recursive: true }) as string[]) {
      const leaf = basename(name)
      // Crunchyroll 这类 DASH 是「一个 rendition 一个整文件」：RE 在写盘时把文件命名为
      // `<n>.mp4.tmp.downloading`（另有同名 `.meta`），整段下完才改成 `<n>.mp4`。
      // 旧规则只认 `.tmp`，于是整段下载期间「已完成字节」恒为 0，界面只能显示 0 B/s。
      if (!/^(?:\d+|_init)\.(?:ts|m4s|mp4|m4a|clip|webm)(?:\.tmp(?:\.downloading)?)?$/.test(leaf)) continue
      const size = fileSize(join(root, name))
      bytes += size
      if (size > 0 && !/\.tmp(?:\.downloading)?$/.test(leaf)) done++
    }
    return { done: Math.min(done, total), total, bytes }
  } catch { /* RE has not created its fragment folder yet */ }
}

/** Segment total from RE's "Selected streams" listing, once the listing is complete. */
export function reListedSegments(text: string): number | undefined {
  const s = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  const start = s.search(/已选择的流:|已選擇的流:|Selected streams:/)
  if (start < 0) return
  let total = 0
  for (const line of s.slice(start).split(/\r?\n/).slice(1)) {
    if (/保存文件名:|保存檔案名:|Save Name:/.test(line)) return total || undefined
    const count = /\|\s*(\d+) Segments?\b/.exec(line)
    if (count) total += Number(count[1])
  }
  // The listing is still arriving; a partial sum would end the download phase early.
}

function fileSize(path: string): number {
  try {
    const st = statSync(path)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

function dirFileSizes(dir: string, pred?: (name: string) => boolean): number {
  let n = 0
  try {
    for (const name of readdirSync(dir)) {
      if (pred && !pred(name)) continue
      n += fileSize(join(dir, name))
    }
  } catch { /* missing until RE creates it */ }
  return n
}

/** The managed downloader merges/decrypts each HLS part inside its track
 * directory. Its atomic decrypt output is a GUID, renamed to part.mp4 only
 * on success. Other tracks can still be pending during this operation. */
function rePartSidecar(dir: string): { phase: 'merge' | 'decrypt'; ratio: number; log: string } | undefined {
  const root = join(dir, 'download')
  try {
    const files = (readdirSync(root, { recursive: true }) as string[]).map(name => {
      const path = join(root, name)
      try { const st = statSync(path); return st.isFile() ? {path,name,size:st.size,at:st.mtimeMs} : undefined } catch { return undefined }
    }).filter((file): file is NonNullable<typeof file> => !!file)
    const fragment = /^(?:\d+|_init)\.(?:ts|m4s|mp4|m4a|clip|webm)(?:\.tmp)?$/
    const sources = files.filter(file => /(?:^|[\\/])parts[\\/]\d+[\\/]part\.(?:mp4|m4a|ts|webm)$/.test(file.name))
    for (const src of sources.sort((a,b)=>b.at-a.at)) {
      const parent = dirname(src.path)
      const outputs = files.filter(file => dirname(file.path) === parent && /^[a-f\d]{32}\.(?:mp4|m4a|ts|webm)$/i.test(basename(file.path)))
      const written = outputs.reduce((n,file)=>n+file.size,0)
      if (outputs.length && src.size) return {phase:'decrypt',ratio:Math.min(0.99,written/src.size),log:`解密 ${human(written)}/${human(src.size)}`}
      // Once a later part/track starts downloading, an old completed part
      // must not conceal the new transfer speed.
      if (files.some(file=>fragment.test(basename(file.path)) && file.at>src.at)) continue
      const inputs = files.filter(file => dirname(file.path).startsWith(parent + (process.platform === 'win32' ? '\\' : '/')) && fragment.test(basename(file.path)))
      const total = inputs.reduce((n,file)=>n+file.size,0)
      if (total) return {phase:'merge',ratio:Math.min(1,src.size/total),log:`合并 ${human(src.size)}/${human(total)}`}
    }
  } catch { /* downloader has not created its part directories yet */ }
}

export function reWorkPhase(text: string, workDir?: string, listedTotal?: number): PlaylistPhase {
  if (workDir) {
    const part = rePartSidecar(workDir)
    if (part) return part.phase
  }
  const s = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  // Track processing repeats: use the latest marker instead of letting a
  // historical decrypt message permanently dominate all later tracks.
  const markers = [...s.matchAll(/Decrypting using|二进制合并|Binary merging|ffmpeg合并|ffmpeg merging/gi)]
  const last = markers.at(-1)?.[0] ?? ''
  const phase = /Decrypting using/i.test(last) ? 'decrypt' : last ? 'merge' : 'download'
  if (phase !== 'download' && workDir) {
    const segments = reDownloadedSegments(workDir, listedTotal)
    if (segments && segments.done < segments.total) return 'download'
  }
  return phase
}

/** `-mt`: N_m3u8DL-RE is sequential per stream unless told otherwise. */
export function streamConcurrencyArgs(enabled: boolean): string[] {
  return enabled ? ['-mt'] : []
}

/** Byte progress for RE merge / Shaka decrypt. Demux has no output yet. */
export function reSidecarProgress(dir: string, phase: 'merge' | 'decrypt'): { ratio: number; log: string } {
  const part = rePartSidecar(dir)
  if (part?.phase === phase) return part
  if (phase === 'merge') {
    const total = reDownloadedSegments(dir)?.bytes ?? dirFileSizes(join(dir, 'download'), name => !name.endsWith('.json'))
    const done = Math.max(...['mp4', 'ts', 'mkv', 'm4a', 'mka', 'webm'].map(ext => fileSize(join(dir, `download.${ext}`))))
    if (!total) return { ratio: 0, log: '合并' }
    return { ratio: Math.min(1, done / total), log: `合并 ${human(done)}/${human(total)}` }
  }
  const src = fileSize(join(dir, 'download.mp4'))
  if (!src) return { ratio: 0, log: '解密' }
  const tmp = dirFileSizes(dir, (name) => name.startsWith('packager-tempfile'))
  const dec = fileSize(join(dir, 'download_dec.mp4'))
  if (tmp <= 0 && dec <= 0) return { ratio: 0, log: `解密 读取 ${human(src)}` }
  if (dec <= 0) {
    const wrote = Math.min(tmp, src)
    return { ratio: 0.5 * (wrote / src), log: `解密 ${human(wrote)}/${human(src)}` }
  }
  if (tmp <= 0) {
    const wrote = Math.min(dec, src)
    return { ratio: wrote / src, log: `解密 ${human(wrote)}/${human(src)}` }
  }
  const wrote = Math.min(dec, src)
  return { ratio: 0.5 + 0.5 * (wrote / src), log: `解密 回写 ${human(wrote)}/${human(src)}` }
}

export function playlistStatus(label: string, phase: PlaylistPhase): string {
  if (phase === 'download') return label
  const tag = phase === 'merge' ? '合并' : '解密'
  return label === '下载' ? tag : `${label} · ${tag}`
}

export function playlistOverall(phase: PlaylistPhase, fraction: number, decrypts: boolean): number {
  const clamped = Math.min(1, Math.max(0, fraction))
  const download = 0.7
  const merge = decrypts ? 0.08 : 0.29
  const decrypt = decrypts ? 0.21 : 0
  if (phase === 'download') return download * clamped
  if (phase === 'merge') return download + merge * clamped
  return download + merge + decrypt * clamped
}


/** HLS 解密参数。CENC 走 Shaka；AES_128 由 RE 自己解，不需要解密引擎。 */
export type HlsKeyMethod = 'AES_128' | 'CENC' | 'IQ_BBTS'

export function hlsKeyArgs(key?: string, method: HlsKeyMethod = 'CENC'): string[] {
  if (!key) return []
  if (!/^(?:[a-f\d]{32}:)?[a-f\d]{32}$/i.test(key)) throw new Error('解密密钥格式无效，应为 16 字节十六进制 KEY 或 KID:KEY')
  const hex = key.split(':').at(-1)!
  // RE 的 HLS 加密方式用下划线拼写（AES_128 / CENC，见 --morehelp custom-hls-method）。
  // AES-128 只需要 KEY：`--key` 是给 CENC 的 KID:KEY 用的。
  if (method === 'AES_128') return ['--custom-hls-key', hex, '--custom-hls-method', 'AES_128']
  if (method === 'IQ_BBTS') return ['--custom-hls-key', hex, '--custom-hls-method', 'IQ_BBTS', '--custom-hls-scope', 'VIDEO']
  return ['--key', key, '--custom-hls-key', hex, '--custom-hls-method', 'CENC']
}

/** Recognize status messages without treating a recoverable retry as failure. */
export function reHttpFailureMonitor(): { feed: (chunk: string) => number } {
  let tail = ''
  return {
    feed: (chunk) => {
      const lines = (tail + chunk).split(/[\r\n]/)
      tail = lines.pop()?.slice(-2048) ?? ''
      for (const line of lines) {
        const match = line.match(/(?:status code[^\r\n]*?|HTTP\s+)(403|410)\b/i)
        if (match) return Number(match[1])
      }
      return 0
    },
  }
}

/**
 * RE spawns shaka-packager / ffmpeg as children. Use a dedicated process group
 * on POSIX and taskkill /T on Windows so cancellation stops those children too.
 */
function killTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return Promise.resolve()
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('error', () => resolve())
      killer.once('close', () => resolve())
    })
  }
  try { process.kill(-pid, 'SIGKILL') } catch { /* already exited */ }
  return Promise.resolve()
}

export function runM3u8dl(bin: string, args: string[], logFile: string, cb?: ProgressCB, fatalError?: () => Error | undefined, cwd?: string, signal?: AbortSignal): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  if (signal?.aborted) {
    // Never start (and then have to kill) a downloader for a stopped job.
    reject(signal.reason ?? new Error('已停止'))
    return promise
  }
  // A reused scratch folder may contain exhausted retries from an older run.
  // Remove that log before spawning, so the watcher cannot stop a fresh process.
  if (logFile) {
    try { unlinkSync(logFile) } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { reject(e); return promise }
    }
  }
  // The bundled .NET 10 macOS ARM64 runtime can abort in its precompiled HTTP
  // header code during parallel IQ downloads. JIT that code for this path;
  // keep the same downloader, concurrency and fragment restoration behavior.
  const iqMethod = args.indexOf('--custom-hls-method')
  const jitIQ = process.platform === 'darwin' && process.arch === 'arm64'
    && iqMethod >= 0 && args[iqMethod + 1] === 'IQ_BBTS'
  const child = spawn(bin, args, {
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
    env: {
      ...process.env,
      // Spectre recognizes this as a noninteractive environment. A redirected
      // macOS console can report height -1 and crash its live progress renderer.
      TF_BUILD: 'true',
      DOTNET_SYSTEM_NET_HTTP_SOCKETSHTTPHANDLER_HTTP2SUPPORT: 'false',
      ...(jitIQ ? { DOTNET_ReadyToRun: '0' } : {}),
      ...(cwd ? { TMP: cwd, TEMP: cwd, TMPDIR: cwd } : {}),
    },
  })
  let output = ''
  // Runtime crashes print the root exception before a very long stack trace.
  // Keep its beginning as well as the output tail used for normal failures.
  let stderrHead = ''
  let deniedStatus = 0
  let exhausted = false
  let stopped = false
  let stopping: Promise<void> | undefined
  let phase: PlaylistPhase = 'download'
  let decryptAt = 0
  let listedTotal: number | undefined
  const measureTransfer = transferSpeed()
  const failures = reHttpFailureMonitor()
  const stop = () => {
    if (stopped) return
    stopped = true
    stopping = killTree(child.pid)
  }
  const onAbort = () => stop()
  if (signal) {
    if (signal.aborted) stop()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const bumpPhase = (next: PlaylistPhase) => {
    if (next !== phase) decryptAt = next === 'decrypt' ? Date.now() : 0
    phase = next
  }
  /** 控制台百分比：单文件大分段时它是唯一可用的整体进度。 */
  let consoleFrac = 0
  const emitSidecar = () => {
    if (!cb || !cwd) return
    if (phase === 'download') {
      const segments = reDownloadedSegments(cwd, listedTotal)
      if (segments) cb(segments.done > 0 ? Math.min(0.99, segments.done / segments.total) : Math.max(0, consoleFrac), 1, {
        phase, segments: { done: segments.done, total: segments.total }, transfer: measureTransfer(segments.bytes),
      })
      return
    }
    const side = reSidecarProgress(cwd, phase)
    let log = side.log
    if (phase === 'decrypt' && side.ratio === 0 && decryptAt) {
      log = `${side.log} · ${Math.round((Date.now() - decryptAt) / 1000)}s`
    }
    cb(side.ratio, 1, { phase, log })
  }
  const progress = reProgress((n, total, segments) => {
    // 多流（Apple TV：视频 + 多条配音 + 字幕）时 RE 的控制台行会先被最短的流
    // 顶到 100%；一旦有分段落盘就只认文件系统计数。但整文件型 DASH（CR）在下载期间
    // 没有任何已完成分段，此时仍用控制台百分比，避免进度条一直停在 0%。
    consoleFrac = total > 1 ? n / total : n
    const onDisk = cwd ? reDownloadedSegments(cwd, listedTotal) : undefined
    if (onDisk && onDisk.done > 0) return
    cb?.(n, total, { phase: 'download', segments })
  })
  // Take the resume baseline before any newly downloaded bytes are reported.
  emitSidecar()
  const collect = (chunk: string) => {
    output = (output + chunk).slice(-16384)
    listedTotal ??= reListedSegments(output)
    bumpPhase(reWorkPhase(chunk, cwd, listedTotal))
    progress(chunk)
    emitSidecar()
    const status = failures.feed(chunk)
    if (status) deniedStatus = status
    // RE retries a failed segment itself. Interrupt only after it explicitly
    // gives up, never on the first 403 (or a historical 403 followed by success).
    if (deniedStatus && /retry attempts have been exhausted/i.test(output)) {
      exhausted = true
      stop()
    }
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', collect)
  child.stderr.on('data', (chunk: string) => {
    stderrHead = (stderrHead + chunk).slice(0, 4000)
    collect(chunk)
  })
  const logWatch = (logFile || cwd || fatalError) ? setInterval(() => {
    if (stopped) return
    if (fatalError?.()) { stop(); return }
    if (exhausted) return
    let log = ''
    if (logFile) {
      try {
        log = readFileSync(logFile, 'utf8').slice(-16384)
        const status = reHttpFailureMonitor().feed(log + '\n')
        if (status) deniedStatus = status
        if (deniedStatus && /retry attempts have been exhausted/i.test(log)) {
          exhausted = true
          stop()
        }
      } catch { /* log is not created yet */ }
    }
    bumpPhase(reWorkPhase(log + '\n' + output, cwd, listedTotal))
    emitSidecar()
  }, 250) : undefined
  const stopLogWatch = () => { clearInterval(logWatch) }
  child.once('error', (e) => {
    stopLogWatch()
    signal?.removeEventListener('abort', onAbort)
    if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return }
    reject(new Error(`无法启动 N_m3u8DL-RE: ${e.message}`))
  })
  child.once('close', async (code, killSignal) => {
    stopLogWatch()
    signal?.removeEventListener('abort', onAbort)
    await stopping
    // A caller stop is not a download error: report it as the abort. An
    // internal stop (exhausted retries / fatal relay) still reports below.
    if (stopped && signal?.aborted) { reject(signal.reason ?? new Error('已停止')); return }
    const fatal = fatalError?.()
    if (fatal) { reject(fatal); return }
    let file = ''
    try { file = readFileSync(logFile, 'utf8') } catch { /* no log */ }
    // A parallel worker can report HTTP 502 before another worker exits on an
    // unsupported media format. Preserve the root error before CDN detection;
    // refreshing signed URLs cannot resolve an explicit format incompatibility.
    const compatibilityDetails = cleanRELog(stderrHead + '\n' + file + '\n' + output)
    if ((code !== 0 || exhausted) && hasUnsupportedDownloaderFormat(compatibilityDetails)) {
      reject(new DownloaderCompatibilityError(`${compatibilityDetails.slice(0, 2000)}\n${compatibilityDetails.slice(-2000)}`))
      return
    }
    // Some RE errors are written only to the log or have no final newline.
    const status = deniedStatus || reHttpFailureMonitor().feed(file + '\n' + output + '\n')
    if (status && (code !== 0 || exhausted)) { reject(new CdnDenied(status, '')); return }
    const text = cleanRELog(file + '\n' + output)
    const failed = /ERROR:\s*Failed|分片数量校验不通过|Segment count check not pass|Decryption failed|解密失败/i.test(text)
    if (code === 0 && !failed) resolve(text)
    else {
      const slow = /Download speed too slow/i.test(text) ? 'Download speed too slow! ' : ''
      const crashed = killSignal && ['SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGILL'].includes(killSignal)
      const details = crashed ? `${cleanRELog(stderrHead).slice(0, 2000)}\n${text.slice(-2000)}` : text.slice(-4000)
      reject(new Error(`N_m3u8DL-RE 下载失败 (${killSignal || code}): ${slow}${details}`))
    }
  })
  return promise
}

/** HLS/DASH via N_m3u8DL-RE. Merge fragments before decrypting the complete track. */
/** Segment-level cipher without EXT-X-KEY in the playlist (Tencent ChaCha20). */
export type HlsCipher = { method: string; key: string; iv: string }

/** Tencent mirrors may answer with a 200 "Forbidden" HTML page from some
 * networks; return the first candidate that actually serves a playlist. */
export async function firstLivePlaylist(urls: string[], ref: string, signal?: AbortSignal): Promise<string> {
  const tried: string[] = []
  for (const u of urls) {
    try {
      const res = await fetch(u, { headers: headersFor(ref), signal: combinedSignal(signal, 15_000) })
      if ((await res.text()).trimStart().startsWith('#EXTM3U')) return u
      tried.push(`${new URL(u).host} HTTP ${res.status}`)
    } catch (e) {
      signal?.throwIfAborted()
      tried.push(`${u.split('/')[2] ?? u} ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  throw new Error(`所有 CDN 都没有返回播放列表：${tried.join("；")}`)
}

/** True when the first media segment is not plaintext MPEG-TS. */
export async function hlsSegmentsEncrypted(src: string, ref: string, signal?: AbortSignal): Promise<boolean> {
  const res = await fetch(src, { headers: headersFor(ref), signal })
  const playlist = await res.text()
  if (!playlist.trimStart().startsWith('#EXTM3U')) throw new Error(`播放列表不可用（HTTP ${res.status}）`)
  const first = playlist.split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#'))
  if (!first) throw new Error('播放列表没有分片')
  const seg = await fetch(new URL(first, res.url || src), { headers: { ...headersFor(ref), Range: 'bytes=0-376' }, signal })
  const b = new Uint8Array(await seg.arrayBuffer())
  return !(b[0] === 0x47 && b[188] === 0x47)
}

/** RE subtitle selection: all, none, or exact rendition files (regex-escaped, OR-ed). */
function subtitleSelect(uris?: string[]): string[] {
  if (!uris) return ['--select-subtitle', 'all']
  const ok = uris.filter(u => /^[\w.-]+$/.test(u))
  if (!ok.length) return ['--drop-subtitle', 'all']
  return ['--select-subtitle', `url=(${ok.map(u => u.replace(/[.-]/g, m => `\\${m}`)).join('|')}):for=all`]
}

export async function downloadPlaylist(opts: {
  src: string
  dest: string
  ref: string
  headers?: Record<string, string>
  key?: string
  /** Explicit Widevine download: per-content KID:KEY pairs, never CDM credentials. */
  contentKeys?: string[]
  /** Keep selected provider subtitle groups when muxing a complete HLS master. */
  keepSubtitles?: boolean
  /** Exact subtitle renditions to keep (playlist file names); [] drops all; undefined keeps all when keepSubtitles. */
  subtitleUris?: string[]
  /** Already fetched by the gateway before a short-lived MPD signature expires. */
  manifestText?: string
  /** Select an exact pixel height while keeping the best audio. */
  videoHeight?: number
  /** Extra RE video filter, e.g. codecs (Disney+ DV / HDR10 / SDR share a height). */
  videoCodecs?: string
  /** Exact audio renditions to keep (playlist file names); default: RE's best single audio. */
  audioUris?: string[]
  /** Explicit bounded validation/download range, in segment indices. */
  segmentRange?: string
  /** HLS 密钥算法。默认 CENC（优酷）；黄果是 AES_128。 */
  keyMethod?: HlsKeyMethod
  /** Provider-specific legacy TS handling. Must return an MP4; never guesses a cipher. */
  prepareCencTs?: (source: string, progress: (bytes: number, total: number) => void) => Promise<string>
  cipher?: HlsCipher
  /** Only set when the gateway explicitly says the selected track is clear. */
  clear?: boolean
  threads?: number
  /** Explicit HTTP proxy for RE (providers whose CDN requires a fixed exit IP). */
  proxy?: string
  /** Download/decrypt each selected stream concurrently (`-mt`); N_m3u8DL-RE is
   *  sequential by default, so audio waits for the whole video track. */
  concurrentStreams?: boolean
  cb?: ProgressCB
  select?: 'video' | 'audio' | 'muxed'
  /** Combine separate audio/video from a clear master HLS or DASH into MKV. */
  muxTracks?: boolean
  /** Matched original language for a single embedded audio track. Use our mux
   * so RE's generic English tag cannot override confirmed title metadata. */
  muxOriginalAudioLanguage?: string
  /** Release group written as a global MKV tag by the local mux. */
  releaseGroup?: string
  /** Use the original JS CDN transport while RE handles HLS/merge/decryption. */
  transport?: 'node' | 're'
  refreshSource?: () => Promise<{ src: string; key?: string }>
  onRefresh?: (attempt: number, total: number) => void
  /**
   * Explicit parent for RE's scratch folder. When set, the folder is a
   * track parent can reuse downloaded segments when resumeIdentity is set;
   * otherwise retries start afresh beside `dest` for same-volume renames.
   */
  workDir?: string
  /** Whitespace-free suffix identifying this track inside `workDir`. */
  workTag?: string
  /** Provider-verified hash of rendition, timeline and key, permitting fragment reuse. */
  resumeIdentity?: string
  signal?: AbortSignal
  /** Reports the fallback to system temp when `workDir` cannot be created. */
  log?: (msg: string) => void
}): Promise<void> {
  opts.signal?.throwIfAborted()
  const executable = await ensureM3u8dl()
  mkdirSync(dirname(opts.dest), { recursive: true })
  const tag = workTagOf(opts.workTag, opts.dest)
  if (opts.workDir && !opts.resumeIdentity) {
    // A deterministic parent means an aborted run could otherwise pile up
    // `re-*` folders forever; RE cannot be trusted to resume those fragments
    // cheaply, so a restart always starts from an empty folder.
    removeStaleChildren(join(opts.workDir, tag))
  }
  const workDir = opts.workDir
    ? opts.resumeIdentity ? resumeScratchDir(join(opts.workDir, tag), opts.resumeIdentity, opts.log)
      : scratchDirIn(join(opts.workDir, tag), 're-', opts.log)
    : scratchDir(opts.dest, 'gvs-re-')
  const logFile = join(workDir, 're.log')
  const iqKeyFile = join(workDir, 'iq-key.bin')
  const contentKeyFile = join(workDir, 'content-keys.txt')
  const errorLog = `${opts.dest}.download-error.log`
  let diagnostics = ''
  const relayEvents: RelayEvent[] = []
  let relay: Awaited<ReturnType<typeof createHlsRelay>> | undefined
  let succeeded = false
  try {
    const threads = Number.isFinite(opts.threads) ? Math.max(1, Math.floor(opts.threads!)) : 1
    const ffmpeg = await ensureFFmpeg()
    const keyArgs = hlsKeyArgs(opts.key, opts.keyMethod)
    if (opts.key && opts.keyMethod === 'IQ_BBTS') {
      writeFileSync(iqKeyFile, Buffer.from(opts.key.split(':').at(-1)!, 'hex'), { mode: 0o600 })
      keyArgs[keyArgs.indexOf('--custom-hls-key') + 1] = iqKeyFile
    }
    let source = opts.src
    if (opts.manifestText) {
      const manifestKind = opts.manifestText.trimStart().startsWith('#EXTM3U') ? 'm3u8' : opts.manifestText.trimStart().startsWith('<') && /<(?:\w+:)?MPD\b/.test(opts.manifestText) ? 'mpd' : ''
      if (!manifestKind || Buffer.byteLength(opts.manifestText) > 8 << 20) throw new Error('网关返回的媒体清单无效')
      source = join(workDir, `source.${manifestKind}`)
      writeFileSync(source, opts.manifestText, { mode: 0o600 })
    } else if (opts.transport === 'node') {
      // The supplied CENC key replaces remote/skd key discovery entirely.
      relay = await createHlsRelay(opts.src, headersFor(opts.ref, 0, opts.headers), opts.clear || !!opts.key, {
        // 403/410 refreshes the authenticated source in-place, not the old URL.
        maxAttempts: 1,
        refreshSource: opts.refreshSource ? async () => {
          const next = await opts.refreshSource!()
          if (next.key !== opts.key) throw new Error('重新取链后解密密钥改变，已停止以免混入不同加密内容')
          return next.src
        } : undefined,
        onRefresh: opts.onRefresh,
        signal: opts.signal,
        onResponse: event => { relayEvents.push(event); if (relayEvents.length > 1500) relayEvents.shift() },
      })
      source = relay.url
    } else if (opts.clear) {
      const response = await cdnResponse(source, opts.ref, opts.headers)
      const playlist = await response.text()
      if (!playlist.trimStart().startsWith('#EXTM3U') || playlist.includes('#EXT-X-STREAM-INF')) {
        throw new Error('明文轨道需要独立 HLS 媒体播放列表')
      }
      source = join(workDir, 'clear.m3u8')
      const base = response.url || opts.src
      const normalized = playlist.split(/\r?\n/).filter((line) => !line.startsWith('#EXT-X-KEY:'))
        .map((line) => line.startsWith('#')
          ? line.replace(/URI="([^"]+)"/g, (_, uri: string) => `URI="${new URL(uri, base).href}"`)
          : line.trim() ? new URL(line.trim(), base).href : '').join('\n')
      writeFileSync(source, normalized)
    }
    const args = [
      source,
      '--save-dir', workDir,
      '--tmp-dir', workDir,
      '--save-name', 'download',
      // video: drop embedded audio (帧享 HQ separate-audio path).
      // muxed: keep A/V from one playlist (酷喵 TV / App).
      // audio: auto-select; RE may label standalone audio as Vid.
      ...(opts.select === 'video' ? ['--select-video'] : opts.contentKeys?.length && opts.select === 'muxed' ? [] : ['--auto-select']),
      ...(opts.select === 'video' ? ['best'] : []),
      ...(opts.select === 'video' ? ['--drop-audio', 'all', '--drop-subtitle', 'all'] : []),
      ...(opts.select === 'muxed' ? opts.keepSubtitles ? subtitleSelect(opts.subtitleUris) : ['--drop-subtitle', 'all'] : []),
      '--binary-merge',
      '--del-after-done', 'true',
      // Keep RE's redirected-output detection. Its forced ANSI/NonAnsiWriter
      // console assumes a screen height and can crash when stdout is a pipe.
      '--disable-update-check',
      '--log-file-path', logFile,
      '--thread-count', String(threads),
      ...streamConcurrencyArgs(!!opts.concurrentStreams),
      '--download-retry-count', String(opts.refreshSource ? 0 : MAX_ATTEMPTS - 1),
      ...(opts.refreshSource ? ['--http-request-timeout', '360'] : []),
    ]
    if (opts.manifestText) args.push('--base-url', opts.src)
    if (opts.segmentRange) {
      if (!/^\d+-\d+$/.test(opts.segmentRange)) throw new Error('分片范围格式无效')
      const [start, end] = opts.segmentRange.split('-').map(Number)
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) throw new Error('分片范围无效')
      args.push('--custom-range', opts.segmentRange)
    }
    if ((opts.videoHeight || opts.contentKeys?.length) && opts.select === 'muxed') {
      if (opts.videoHeight && (!Number.isInteger(opts.videoHeight) || opts.videoHeight < 1 || opts.videoHeight > 8640)) throw new Error('视频分辨率选择无效')
      if (opts.videoCodecs && !/^[a-z0-9|]+$/i.test(opts.videoCodecs)) throw new Error('视频编码选择无效')
      const video = opts.videoHeight ? `res=^[0-9]+x${opts.videoHeight}$${opts.videoCodecs ? `:codecs=^(${opts.videoCodecs})`: ''}:for=best` : 'best'
      const uris = (opts.audioUris || []).filter(u => /^[\w.-]+$/.test(u))
      const audio = uris.length ? `url=(${uris.map(u => u.replace(/[.-]/g, m => `\\${m}`)).join('|')}):for=all` : 'best'
      args.push('--select-video', video, '--select-audio', audio)
    }
    if (opts.muxTracks && !opts.muxOriginalAudioLanguage && !opts.releaseGroup?.trim()) {
      const mkvmerge = await ensureMkvmerge()
      args.push('--mux-after-done', `format=mkv:muxer=mkvmerge:bin_path="${mkvmerge.replaceAll(':', '\\:')}"`)
    }
    if (ffmpeg) args.push('--ffmpeg-binary-path', ffmpeg)
    if (relay) args.push('--use-system-proxy', 'false')
    else if (opts.proxy) args.push('--custom-proxy', normalizeHttpProxy(opts.proxy))
    if (opts.cipher) args.push('--custom-hls-method', opts.cipher.method, '--custom-hls-key', opts.cipher.key, '--custom-hls-iv', opts.cipher.iv)
    for (const [name, value] of Object.entries(headersFor(opts.ref, 0, opts.headers))) args.push('--header', `${name.toLowerCase()}: ${value}`)
    if (opts.key) {
      // CENC 由 Shaka 整轨解密；AES-128 由 RE 内置解密，给 --custom-hls-key 就够。
      if ((opts.keyMethod ?? 'CENC') === 'CENC') {
        const packager = await ensurePackager()
        args.push(
          ...keyArgs,
          '--decryption-engine', 'SHAKA_PACKAGER',
          '--decryption-binary-path', packager,
          // Decrypt the whole track once. Per-segment Shaka output consists of
          // standalone MP4 movies; byte-concatenating those repeats moov/edit lists.
        )
      } else {
        args.push(...keyArgs)
      }
    }
    if (opts.contentKeys?.length) {
      if (opts.key || opts.cipher || opts.contentKeys.length > 128 || opts.contentKeys.some(key => !/^[a-f\d]{32}:[a-f\d]{32}$/i.test(key))) throw new Error('内容密钥集合无效')
      writeFileSync(contentKeyFile, opts.contentKeys.join('\n'), { mode: 0o600 })
      const packager = await ensurePackager()
      args.push('--no-config', '--no-log', '--write-meta-json', 'false', '--key-text-file', contentKeyFile,
        '--decryption-engine', 'SHAKA_PACKAGER', '--decryption-binary-path', packager)
    }
    opts.cb?.(0, 1, { phase: 'download' })
    let progress = 0
    let phase: PlaylistPhase = 'download'
    let lastDiagnosticAt = 0
    let lastDiagnosticPhase: PlaylistPhase | undefined
    const decrypts = !!opts.key || !!opts.contentKeys?.length
    const report: ProgressCB = (n, total, info) => {
      const frac = total > 1 ? n / total : n
      if (info?.phase) {
        phase = info.phase
      }
      progress = Math.max(progress, Math.min(0.99, playlistOverall(phase, frac, decrypts)))
      opts.cb?.(progress, 1, { phase, log: info?.log, segments: info?.segments, transfer: info?.transfer })
      if (lastDiagnosticPhase !== phase || Date.now() - lastDiagnosticAt >= 30_000) {
        lastDiagnosticAt = Date.now()
        lastDiagnosticPhase = phase
        const fragments = info?.segments ? ` segments=${info.segments.done}/${info.segments.total}` : ''
        runLog(`playlist work=${workDir} phase=${phase} pct=${(progress * 100).toFixed(1)}${fragments} ${cleanRELog(info?.log || '')}`)
      }
    }
    for (let slowRestart = 0; ; slowRestart++) {
      try {
        diagnostics = await runM3u8dl(executable, args, logFile, report, relay?.error, workDir, opts.signal)
        break
      } catch (e) {
        // A pause/cancel must not be treated as RE's zero-speed watchdog.
        if (opts.signal?.aborted) throw e
        // RE's hard-coded 20s zero-speed watchdog may fire while play() is
        // issuing fresh signed URLs. Wait for that same refresh, then reuse
        // the exact RE work directory and stable local playlist/segment ids.
        if (!relay || !opts.refreshSource || slowRestart >= 2 || !/Download speed too slow/i.test(e instanceof Error ? e.message : String(e))) throw e
        await relay.waitForRefresh()
      }
    }
    opts.signal?.throwIfAborted()
    let found = pickREOutput(workDir, opts.muxTracks)
    if (!found && opts.muxTracks) {
      // Use our mux for language correction, or when RE disables its own mux
      // for Dolby Vision. Complete downloaded tracks remain at the root.
      const inputs = readdirSync(workDir).filter(name => /^download(?:\.[\w-]+)*\.(?:mp4|mka|mkv|m4a|aac|ac3|eac3|ts|webm|srt|vtt|ass)$/i.test(name))
        .map(name => join(workDir,name)).filter(path=>fileSize(path)>0)
      if (inputs.length) {
        const merged = join(workDir,'download.MUX.mkv')
        runLog(`playlist work=${workDir} fallback=mkvmerge tracks=${inputs.length}`)
        report(0,1,{phase:'merge',log:'下载完成；本机封装 MKV'})
        await mkvmergeTrackFiles(await ensureMkvmerge(),inputs,merged,(n,total)=>{
          report(Math.min(0.99,n/Math.max(1,total)),1,{phase:'merge',log:`封装 MKV ${human(n)}/${human(total)}`})
        },opts.signal,opts.muxOriginalAudioLanguage,opts.releaseGroup)
        found = merged
      }
    }
    if (!found) {
      const status = reHttpFailureMonitor().feed(diagnostics + '\n')
      if (status) throw new CdnDenied(status, '')
      throw new Error(`N_m3u8DL-RE 未生成文件：${diagnostics.slice(-3000) || '下载器未返回诊断信息'}`)
    }
    const expectsCenc = (!!opts.key && (opts.keyMethod ?? 'CENC') === 'CENC') || !!opts.contentKeys?.length
    if (expectsCenc && opts.prepareCencTs && isMpegTsFile(found)) {
      opts.cb?.(playlistOverall('decrypt', 0, true), 1, { phase: 'decrypt', log: '处理优酷 TS 音视频包' })
      found = await opts.prepareCencTs(found, (n, total) => {
        opts.cb?.(playlistOverall('decrypt', Math.min(0.99, n/Math.max(1,total)), true), 1, { phase: 'decrypt', log: '处理优酷 TS 音视频包' })
      })
    }
    assertCencMp4Output(found, expectsCenc)
    try { unlinkSync(opts.dest) } catch { /* first write */ }
    moveFileSync(found, opts.dest)
    if (statSync(opts.dest).size === 0) throw new Error('N_m3u8DL-RE 生成的文件为空')
    if (relay) writeFileSync(`${opts.dest}.transport.json`, JSON.stringify({ transport: 'node', completed: true, threads, ...relay.stats(), requests: relayEvents }, null, 2))
    try { unlinkSync(errorLog) } catch { /* no previous failure */ }
    opts.cb?.(1, 1, { phase: decrypts ? 'decrypt' : 'merge' })
    succeeded = true
  } catch (e) {
    try {
      let log = ''
      try { log = readFileSync(logFile, 'utf8') } catch { /* downloader did not start */ }
      writeFileSync(errorLog, cleanRELog(`${e instanceof Error ? e.message : String(e)}\n${log}\n${diagnostics}\n${JSON.stringify({ transport: opts.transport ?? 're', workDirectory: workDir, requests: relayEvents }, null, 2)}`))
    } catch { /* preserve the original failure if the diagnostic cannot be saved */ }
    throw e
  } finally {
    try { unlinkSync(iqKeyFile) } catch { /* no IQ key or downloader already removed it */ }
    try { unlinkSync(contentKeyFile) } catch { /* no content keys or downloader already removed it */ }
    await relay?.close()
    try {
      if (succeeded || !readdirSync(workDir).length) removeScratch(workDir)
    } catch { /* dest already written; a failed download keeps its scratch folder beside the episode */ }
  }
}

/**
 * Download `src` to `dest`. Uses several connections when the CDN supports
 * byte ranges, and resumes from whatever is already on disk when the transfer
 * dies. `note` is called on every retry so the job row can say what is being
 * retried instead of sitting at a frozen percentage.
 */
export async function downloadProgress(
  src: string,
  dest: string,
  ref: string,
  cb?: ProgressCB,
  note?: RetryNote,
  threads = 1,
  cipher?: HlsCipher,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  fetcher: MediaFetch = fetch,
): Promise<void> {
  if (/\.(?:m3u8|mpd)/i.test(src)) {
    const tmp = /\.mkv$/i.test(dest) ? `${dest}.re.mp4` : dest
    await downloadPlaylist({ src, dest: tmp, ref, threads, cb, cipher, headers, signal })
    if (tmp !== dest) {
      const mkvmerge = await ensureMkvmerge()
      await mkvmergeRemux(mkvmerge, tmp, dest, cb, signal)
      try { unlinkSync(tmp) } catch { /* keep */ }
    }
    return
  }
  if (cipher) throw new Error('加密片源只支持 HLS 播放列表下载')
  // One identity for this call: a refreshed URL therefore discards the bytes
  // downloaded from the previous one instead of appending to them.
  const identity = sourceIdentity(src, cipher)
  if (threads > 1) {
    const probe = await probeRange(src, ref, headers, signal, fetcher)
    if (probe.ranges && probe.total >= PARALLEL_MIN_BYTES) {
      try {
        return await downloadParallel(src, dest, ref, probe.total, threads, cb, note, headers, signal, identity, fetcher)
      } catch (e) {
        if (signal?.aborted) throw e
        if (e instanceof Error && /cdn ignored range/.test(e.message)) {
          note?.(1, MAX_ATTEMPTS, 'CDN 不支持分段，改用单连接')
        } else {
          throw e
        }
      }
    }
  }
  return downloadSingle(src, dest, ref, cb, note, headers, signal, identity, fetcher)
}

async function downloadSingle(
  src: string,
  dest: string,
  ref: string,
  cb?: (n: number, total: number) => void,
  note?: RetryNote,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  identity?: string,
  fetcher: MediaFetch = fetch,
): Promise<void> {
  let have = resumableBytes(dest, identity)
  for (let round = 1; round <= MAX_ATTEMPTS; round++) {
    const { res, body } = await openStream(src, ref, have, note, headers, signal, fetcher)
    if (!body) throw new Error('cdn empty body')
    const len = Number(res.headers.get('content-length') ?? 0)
    const total = have + len
    const file = createWriteStream(dest, { flags: have > 0 ? 'a' : 'w' })
    let n = have
    const node = Readable.fromWeb(body as unknown as NodeWebReadableStream)
    node.on('data', (chunk: Buffer | Uint8Array) => {
      n += chunk.length
      cb?.(n, total)
    })
    try {
      await pipeline(node, file, { signal })
      cb?.(n, total)
      clearResumeState(dest)
      return
    } catch (e) {
      if (signal?.aborted) throw signal.reason ?? e
      have = n
      if (round === MAX_ATTEMPTS) throw e
      // Treat the partial file as valid for this source so the next round
      // resumes from it instead of restarting (or discarding) the bytes.
      writeResumeState(dest, identity, have)
      note?.(round, MAX_ATTEMPTS, `传输中断，从 ${human(have)} 续传`)
      await sleep(Math.min(1000 * 2 ** (round - 1), 8000), signal)
    }
  }
}

export async function appendURL(dest: string, src: string, ref: string, note?: RetryNote): Promise<void> {
  const { res, body } = await openStream(src, ref, 0, note)
  if (!body) throw new Error('cdn empty body')
  const file = createWriteStream(dest, { flags: 'a' })
  await pipeline(Readable.fromWeb(body as unknown as NodeWebReadableStream), file)
}

/**
 * Pull many small files (优酷 CMAF 分片) in parallel but append them in order.
 * Fetches run `threads` at a time while a bounded window of finished segments
 * waits its turn, so a slow early segment cannot reorder the output or blow up
 * memory.
 */
export async function appendURLs(
  dest: string,
  urls: string[],
  ref: string,
  threads: number,
  onEach?: (index: number, total: number) => void,
  note?: RetryNote,
  signal?: AbortSignal,
): Promise<void> {
  if (!urls.length) return
  signal?.throwIfAborted()
  const identity = sourceIdentity(urls[0]!)
  const baseline = resumableBytes(dest, identity)
  let flushedBytes = baseline
  // 分片走并发：实测同一批优酷分片，单连接 11.7 MB/s、8 并发 81 MB/s（输出 sha256 完全一致）。
  const first = await fetchBuffer(urls[0]!, ref, note, signal)
  const limit = Math.max(1, Math.min(16, threads))
  const window = limit * 2
  const file = createWriteStream(dest, { flags: 'a' })
  let writeChain = Promise.resolve()
  const push = (buf: Buffer) => {
    writeChain = writeChain.then(
      () => new Promise<void>((resolve, reject) => file.write(buf, (err) => (err ? reject(err) : resolve()))),
    )
    return writeChain
  }

  let issued = 1
  let flushed = 0
  let bufferedBytes = first.length
  const pending = new Map<number, Buffer>([[0, first]])

  const flushReady = async () => {
    while (pending.has(flushed)) {
      const ready = pending.get(flushed)!
      pending.delete(flushed)
      bufferedBytes -= ready.length
      await push(ready)
      flushedBytes += ready.length
      flushed++
      onEach?.(flushed, urls.length)
    }
  }

  // Drain the seeded prefix first, otherwise the backpressure check below can
  // wait forever in the single-worker case.
  await flushReady()

  const worker = async () => {
    for (;;) {
      signal?.throwIfAborted()
      while (issued < urls.length && (issued - flushed >= window || bufferedBytes > SEGMENT_BUFFER_BYTES)) {
        await flushReady()
        await sleep(10, signal)
      }
      if (issued >= urls.length) return
      const index = issued++
      const buf = await fetchBuffer(urls[index]!, ref, note, signal)
      bufferedBytes += buf.length
      pending.set(index, buf)
      await flushReady()
    }
  }

  try {
    await Promise.all(Array.from({ length: limit }, worker))
    await flushReady()
    clearResumeState(dest)
  } catch (e) {
    // Only the bytes already written in order belong to this source, so a
    // retry appends after them instead of re-fetching the whole list.
    writeResumeState(dest, identity, flushedBytes)
    throw e
  } finally {
    await push(Buffer.alloc(0))
    await new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve())))
  }
}

async function fetchBuffer(src: string, ref: string, note?: RetryNote, signal?: AbortSignal): Promise<Buffer> {
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { res, body } = await openStream(src, ref, 0, note, undefined, signal)
      if (!body) throw new Error('cdn empty body')
      return Buffer.from(await res.arrayBuffer())
    } catch (e) {
      if (signal?.aborted) throw signal.reason ?? e
      lastErr = e
      if (attempt >= MAX_ATTEMPTS) break
      note?.(attempt, MAX_ATTEMPTS, `分片重试`)
      await sleep(Math.min(500 * 2 ** (attempt - 1), 6000), signal)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('segment fetch failed')
}

export async function parseCMAF(playlistURL: string, ref: string): Promise<{ initURL: string; segs: string[] }> {
  const res = await cdnResponse(playlistURL, ref)
  const text = await res.text()
  const slash = playlistURL.lastIndexOf('/')
  const base = slash >= 0 ? playlistURL.slice(0, slash + 1) : playlistURL
  const abs = (u: string) => (u.startsWith('http') ? u : base + u)
  let initURL = ''
  const segs: string[] = []
  for (let line of text.split('\n')) {
    line = line.trim()
    if (line.startsWith('#EXT-X-MAP:')) {
      const i = line.indexOf('URI="')
      if (i >= 0) {
        const rest = line.slice(i + 5)
        const j = rest.indexOf('"')
        if (j >= 0) initURL = abs(rest.slice(0, j))
      }
      continue
    }
    if (!line || line.startsWith('#')) continue
    segs.push(abs(line))
  }
  return { initURL, segs }
}

export function hlsExtinfSeconds(text: string): number[] {
  const out: number[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('#EXTINF:')) continue
    const n = Number.parseFloat(line.slice(8))
    if (Number.isFinite(n) && n > 0) out.push(n)
  }
  return out
}

export async function hlsExtinfList(url: string, ref: string): Promise<number[]> {
  const res = await cdnResponse(url, ref)
  return hlsExtinfSeconds(await res.text())
}


export async function youkuStreamURLs(data: Record<string, unknown>, want: string): Promise<string[]> {
  if (want && Array.isArray(data.streams)) {
    for (const s of data.streams) {
      if (!isObj(s)) continue
      if (asString(s.stream_type) !== want) continue
      if (asString(s.media_type).toLowerCase() === 'audio') continue
      const u = asString(s.playlist_url)
      if (u) {
        try {
          const parsed = await parseCMAF(u, referer('youku'))
          return parsed.initURL ? [parsed.initURL, ...parsed.segs] : parsed.segs
        } catch {
          return [u]
        }
      }
    }
  }
  const urls: string[] = []
  if (isObj(data.video)) {
    const init = asString(data.video.init_url)
    if (init) urls.push(init)
    if (Array.isArray(data.video.segment_urls)) {
      for (const x of data.video.segment_urls) {
        if (typeof x === 'string' && x) urls.push(x)
      }
    }
    if (urls.length === 0) {
      const pl = asString(data.video.playlist_url) || asString(data.video.url)
      if (pl) urls.push(pl)
    }
  }
  return urls
}

/**
 * Segment list for one audio track. `want` is the `audio_stream_type` the user
 * picked; when it is empty we take the default track so a single-file mux still
 * carries the platform's preferred audio.
 */
export async function youkuAudioURLs(data: Record<string, unknown>, want: string): Promise<string[]> {
  const tracks = Array.isArray(data.audio_tracks) ? data.audio_tracks : []
  let chosen: Record<string, unknown> | null = null
  for (const tr of tracks) {
    if (!isObj(tr)) continue
    if (want && asString(tr.stream_type) !== want) continue
    if (!chosen || tr.default === true) chosen = tr
  }
  if (!chosen) return []
  const urls: string[] = []
  const playlist = asString(chosen.playlist_url)
  if (playlist) {
    try {
      const parsed = await parseCMAF(playlist, referer('youku'))
      if (parsed.initURL) urls.push(parsed.initURL)
      urls.push(...parsed.segs)
    } catch {
      urls.push(playlist)
    }
  } else {
    const init = asString(chosen.init_url)
    if (init) urls.push(init)
    const segs = Array.isArray(chosen.segment_urls) ? chosen.segment_urls : []
    for (const x of segs) {
      if (typeof x === 'string' && x) urls.push(x)
    }
  }
  return urls
}

/** Resolve only the selected rendition; a refreshed catalogue cannot silently downgrade it. */
function youkuVideoSelection(data: Record<string, unknown>, want: string): { playlist: string; streamType: string } {
  const [streamType = '', source = ''] = want.split('|')
  const expectedLane = source || (streamType.toLowerCase().startsWith('cmfv') ? 'frame_xiang' : '')
  if (expectedLane && asString(data.lane) && asString(data.lane) !== expectedLane) {
    throw new Error('优酷所选来源端与返回的主响应不一致，已停止下载，避免混用音轨和密钥')
  }
  const rows = (Array.isArray(data.streams) ? data.streams.filter(isObj) : [])
    .filter(s => !['audio', 'subtitle'].includes(asString(s.media_type).toLowerCase()))
  if (want) {
    const matches = rows.filter(s => asString(s.stream_type) === streamType && (!source || asString(s.source) === source))
      .map(s => ({ playlist: asString(s.playlist_url) || asString(s.url), streamType: asString(s.stream_type) }))
      .filter(s => s.playlist)
    if (new Set(matches.map(s => s.playlist)).size > 1) throw new Error('优酷所选档位对应多个来源，请重新选择带来源的档位')
    if (matches.length) return matches[0]!
  }
  if (isObj(data.video)) {
    const playlist = asString(data.video.playlist_url) || asString(data.video.url)
    const boundRows = rows.filter(s => playlist && (s.playlist_url === playlist || s.url === playlist))
    const types = new Set([asString(data.video.stream_type), ...boundRows.map(s => asString(s.stream_type))].filter(Boolean))
    const actual = types.size === 1 ? [...types][0]! : ''
    const lane = asString(data.lane) || asString(data.video.source)
    const sourceMatches = !source || lane === source || boundRows.some(s => asString(s.source) === source)
    if (playlist && (!want || actual === streamType && sourceMatches)) return { playlist, streamType: actual }
  }
  if (want) throw new Error(source
    ? '优酷所选来源端没有返回对应档位，请重新取流或选择可用档位'
    : '优酷未返回所选档位，已停止下载，避免静默换成其他画质')
  return { playlist: '', streamType: '' }
}

export function youkuVideoPlaylist(data: Record<string, unknown>, want: string): string {
  return youkuVideoSelection(data, want).playlist
}

/** CMAF video is independent of its audio even when the audio catalogue is missing. */
export function youkuUsesSeparateAudio(data: Record<string, unknown>, quality = ''): boolean {
  return youkuVideoSelection(data, quality).streamType.toLowerCase().startsWith('cmfv')
}

const YOUKU_LANG_KEYS = new Set(['en', 'zh', 'yue'])

/** Stable spoken-language key. Codec names and "default" stay empty. */
export function youkuSpokenLangKey(lang: string, langcode = ''): string {
  const s = `${langcode} ${lang}`.toLowerCase()
  if (/(英语|english|\ben\b|\beng\b)/.test(s)) return 'en'
  if (/(粤|cantonese|\byue\b)/.test(s)) return 'yue'
  if (/(普通|国语|guoyu|mandarin|\bzh\b|\bchi\b|\bcmn\b)/.test(s)) return 'zh'
  return ''
}

/** `vid|streamType|langKey`, `streamType|langKey`, or a bare stream type. */
export function youkuAudioStreamType(trackId: string): string {
  const parts = trackId.split('|').filter(Boolean)
  if (!parts.length) return ''
  if (parts.length === 1) return parts[0]!
  if (YOUKU_LANG_KEYS.has(parts[parts.length - 1]!)) return parts[parts.length - 2]!
  return parts[parts.length - 1]!
}

export function youkuAudioLangKeyFromId(trackId: string): string {
  const parts = trackId.split('|').filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  return YOUKU_LANG_KEYS.has(last) ? last : ''
}

export function youkuAudioPlaylist(data: Record<string, unknown>, want: string, lang = ''): string {
  const tracks = Array.isArray(data.audio_tracks) ? data.audio_tracks : []
  const streamType = youkuAudioStreamType(want)
  const wantKey = youkuSpokenLangKey(lang) || youkuAudioLangKeyFromId(want)
  const candidates: Record<string, unknown>[] = []
  for (const tr of tracks) {
    if (!isObj(tr)) continue
    if (streamType && asString(tr.stream_type) !== streamType) continue
    if (!asString(tr.playlist_url)) continue
    candidates.push(tr)
  }
  if (!candidates.length) return ''
  if (wantKey) {
    const labeled = candidates.filter((tr) => youkuSpokenLangKey(asString(tr.lang), asString(tr.langcode)))
    const hit = labeled.find((tr) => youkuSpokenLangKey(asString(tr.lang), asString(tr.langcode)) === wantKey)
    if (hit) return asString(hit.playlist_url)
    // This vid has no language split. Its playlists belong to the edition itself.
    if (!labeled.length) {
      const def = candidates.find((tr) => tr.default === true) ?? candidates[0]!
      return asString(def.playlist_url)
    }
    return ''
  }
  const def = candidates.find((tr) => tr.default === true) ?? candidates[0]!
  return asString(def.playlist_url)
}
