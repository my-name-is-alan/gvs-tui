import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { asString, human, isObj } from './util.ts'

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
  const headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0' }
  if (ref) headers.Referer = ref
  const res = await fetch(src, { headers })
  if (!res.ok) throw new Error(`cdn ${res.status}`)
  return res
}

export async function downloadProgress(
  src: string,
  dest: string,
  ref: string,
  cb?: (n: number, total: number) => void,
): Promise<void> {
  const res = await cdnResponse(src, ref)
  const total = Number(res.headers.get('content-length') ?? 0)
  if (!res.body) throw new Error('cdn empty body')
  const file = createWriteStream(dest)
  let n = 0
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const node = Readable.fromWeb(res.body as unknown as NodeWebReadableStream) // fetch body is web stream
  node.on('data', (chunk: Buffer) => {
    n += chunk.length
    cb?.(n, total)
  })
  pipeline(node, file).then(resolve, reject)
  return promise
}

export async function appendURL(dest: string, src: string, ref: string): Promise<void> {
  const res = await cdnResponse(src, ref)
  if (!res.body) throw new Error('cdn empty body')
  const file = createWriteStream(dest, { flags: 'a' })
  await pipeline(Readable.fromWeb(res.body as unknown as NodeWebReadableStream), file)
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
