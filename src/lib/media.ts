import { createReadStream, createWriteStream, statSync, unlinkSync } from 'node:fs'
import { once } from 'node:events'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { asString, human, isObj, sleep } from './util.ts'

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

function headersFor(ref: string, from = 0): Record<string, string> {
  const headers: Record<string, string> = {
    // 有些 CDN 只认完整的浏览器头，缺 Accept 也会给 403。
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  }
  if (ref) headers.Referer = ref
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
): Promise<{ res: Response; body: ReadableStream<Uint8Array> | null }> {
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(src, { headers: headersFor(ref, from) })
      if (res.ok || res.status === 206) return { res, body: res.body }
      if (RESPECT_AFTER.has(res.status)) {
        const wait = Number(res.headers.get('retry-after') ?? 0) * 1000
        if (wait > 0 && attempt < MAX_ATTEMPTS) await sleep(Math.min(wait, 10_000))
      }
      if (!RETRY_STATUS.has(res.status)) throw new CdnDenied(res.status, src)
      lastErr = new CdnDenied(res.status, src)
      note?.(attempt, MAX_ATTEMPTS, `HTTP ${res.status}`)
    } catch (e) {
      if (e instanceof CdnDenied && e.status !== 403 && e.status !== 410) throw e
      lastErr = e
      note?.(attempt, MAX_ATTEMPTS, e instanceof Error ? e.message : String(e))
    }
    if (attempt < MAX_ATTEMPTS) await sleep(Math.min(500 * 2 ** (attempt - 1), 8000))
  }
  throw lastErr instanceof Error ? lastErr : new Error('cdn unreachable')
}

const RESPECT_AFTER = new Set([429, 503])

export function referer(p: string): string {
  switch (p) {
    case 'tencent': return 'https://v.qq.com/'
    case 'youku': return 'https://www.youku.com/'
    case 'douyin': return 'https://www.douyin.com/'
    default: return ''
  }
}

export function hongguoItem(data: Record<string, unknown>, vid: string): Record<string, unknown> {
  if (isObj(data.videos)) {
    const hit = data.videos[vid]
    if (isObj(hit)) return hit
    for (const v of Object.values(data.videos)) {
      if (isObj(v)) return v
    }
  }
  if (isObj(data.video)) return data.video
  return data
}

export function pickHongguo(data: Record<string, unknown>, vid: string, want: string): { cdn: string; spade: string; why: string } {
  const item = hongguoItem(data, vid)
  const why = asString(item.err)
  let spade = asString(item.template) || asString(item.spade)
  const wantQ = want.toLowerCase().trim()
  const rank: Record<string, number> = { '1080p': 0, '720p': 1, '540p': 2, '480p': 3, '360p': 4 }
  let best = 99
  let cdn = ''
  const streams = Array.isArray(item.streams) ? item.streams : []
  for (const s of streams) {
    if (!isObj(s)) continue
    const u = asString(s.url)
    const q = asString(s.quality).toLowerCase()
    if (!u) continue
    if (wantQ && q === wantQ) return { cdn: u, spade, why }
    const r = rank[q] ?? 8
    if (r < best) {
      best = r
      cdn = u
    }
  }
  if (!cdn) cdn = asString(item.url)
  return { cdn, spade, why }
}

export function pickURL(data: Record<string, unknown>): string {
  if (isObj(data.video)) {
    const u = asString(data.video.url) || asString(data.video.playlist_url)
    if (u) return u
  }
  return asString(data.url)
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

export function speedCB(
  emit: (status: string, pct: number, log: string) => void,
  status: string,
  base: number,
  span: number,
): (n: number, total: number) => void {
  const start = Date.now()
  let last = 0
  return (n, total) => {
    const now = Date.now()
    if (last && now - last < 250 && (total <= 0 || n < total)) return
    last = now
    let p = base
    if (total > 0) p = base + span * n / total
    const sec = (now - start) / 1000
    const spd = sec > 0.2 ? n / sec : 0
    emit(status, p, `${human(n)}/${total > 0 ? human(total) : '?'}  ${human(spd)}/s`)
  }
}

async function cdnResponse(src: string, ref: string): Promise<Response> {
  const { res } = await openStream(src, ref, 0)
  return res
}

/** Below this size a single connection is already faster than splitting. */
const PARALLEL_MIN_BYTES = 4 << 20
/** Cap on buffered segment bytes while pulling ordered segments. */
const SEGMENT_BUFFER_BYTES = 64 << 20

type RangeProbe = { total: number; ranges: boolean }

/** Ask for one byte to learn the size and whether the CDN honours `Range`. */
async function probeRange(src: string, ref: string): Promise<RangeProbe> {
  try {
    const res = await fetch(src, { headers: { ...headersFor(ref, 0), Range: 'bytes=0-0' } })
    const cr = res.headers.get('content-range') ?? ''
    const total = Number(cr.split('/')[1] ?? 0)
    await res.body?.cancel().catch(() => {})
    if (res.status === 206 && total > 0) return { total, ranges: true }
    const len = Number(res.headers.get('content-length') ?? 0)
    return { total: len, ranges: false }
  } catch {
    return { total: 0, ranges: false }
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
): Promise<void> {
  const parts = Math.max(2, threads)
  const span = Math.ceil(total / parts)
  const sizes = new Array<number>(parts).fill(0)
  const ends = new Array<number>(parts).fill(0)
  let done = 0
  for (let i = 0; i < parts; i++) {
    ends[i] = Math.min(total, (i + 1) * span)
    sizes[i] = Math.min(partSize(partPath(dest, i)), ends[i] - i * span)
    done += sizes[i]
  }
  cb?.(done, total)

  await Promise.all(
    Array.from({ length: parts }, async (_, i) => {
      const start = i * span
      const end = ends[i] - 1
      const path = partPath(dest, i)
      while (sizes[i] < end - start + 1) {
        const from = start + sizes[i]
        let attempt = 0
        for (;;) {
          attempt++
          try {
            const res = await fetch(src, {
              headers: { ...headersFor(ref, from), Range: `bytes=${from}-${end}` },
            })
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
            await pipeline(node, file)
            break
          } catch (e) {
            if (attempt >= MAX_ATTEMPTS) throw e
            note?.(attempt, MAX_ATTEMPTS, `分片 ${i + 1}/${parts} 续传`)
            await sleep(Math.min(800 * 2 ** (attempt - 1), 6000))
          }
        }
      }
    }),
  )

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
  cb?.(total, total)
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
  cb?: (n: number, total: number) => void,
  note?: RetryNote,
  threads = 1,
): Promise<void> {
  if (threads > 1) {
    const probe = await probeRange(src, ref)
    if (probe.ranges && probe.total >= PARALLEL_MIN_BYTES) {
      try {
        return await downloadParallel(src, dest, ref, probe.total, threads, cb, note)
      } catch (e) {
        if (e instanceof Error && /cdn ignored range/.test(e.message)) {
          note?.(1, MAX_ATTEMPTS, 'CDN 不支持分段，改用单连接')
        } else {
          throw e
        }
      }
    }
  }
  return downloadSingle(src, dest, ref, cb, note)
}

async function downloadSingle(
  src: string,
  dest: string,
  ref: string,
  cb?: (n: number, total: number) => void,
  note?: RetryNote,
): Promise<void> {
  let have = 0
  try {
    have = statSync(dest).size
  } catch {
    have = 0
  }
  for (let round = 1; round <= MAX_ATTEMPTS; round++) {
    const { res, body } = await openStream(src, ref, have, note)
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
      await pipeline(node, file)
      cb?.(n, total)
      return
    } catch (e) {
      have = n
      if (round === MAX_ATTEMPTS) throw e
      note?.(round, MAX_ATTEMPTS, `传输中断，从 ${human(have)} 续传`)
      await sleep(Math.min(1000 * 2 ** (round - 1), 8000))
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
): Promise<void> {
  if (!urls.length) return
  // 分片走并发：实测同一批优酷分片，单连接 11.7 MB/s、8 并发 81 MB/s（输出 sha256 完全一致）。
  const first = await fetchBuffer(urls[0]!, ref, note)
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
      flushed++
      onEach?.(flushed, urls.length)
    }
  }

  // Drain the seeded prefix first, otherwise the backpressure check below can
  // wait forever in the single-worker case.
  await flushReady()

  const worker = async () => {
    for (;;) {
      while (issued < urls.length && (issued - flushed >= window || bufferedBytes > SEGMENT_BUFFER_BYTES)) {
        await flushReady()
        await sleep(10)
      }
      if (issued >= urls.length) return
      const index = issued++
      const buf = await fetchBuffer(urls[index]!, ref, note)
      bufferedBytes += buf.length
      pending.set(index, buf)
      await flushReady()
    }
  }

  try {
    await Promise.all(Array.from({ length: limit }, worker))
    await flushReady()
  } finally {
    await push(Buffer.alloc(0))
    await new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve())))
  }
}

async function fetchBuffer(src: string, ref: string, note?: RetryNote): Promise<Buffer> {
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { res, body } = await openStream(src, ref, 0, note)
      if (!body) throw new Error('cdn empty body')
      return Buffer.from(await res.arrayBuffer())
    } catch (e) {
      lastErr = e
      if (attempt >= MAX_ATTEMPTS) break
      note?.(attempt, MAX_ATTEMPTS, `分片重试`)
      await sleep(Math.min(500 * 2 ** (attempt - 1), 6000))
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
