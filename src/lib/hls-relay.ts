import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'

type Resource = { url: string; playlist: boolean }
export class HlsRefreshError extends Error {
  constructor(message: string) { super(message); this.name = 'HlsRefreshError' }
}

function isTransientRefreshError(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof HlsRefreshError || error.name === 'ReloginRequired') return false
  const code = (error as NodeJS.ErrnoException).code ?? ''
  return /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|ConnectionRefused)$/.test(code)
    || /^(?:TimeoutError|AbortError)$/.test(error.name)
    || /(?:HTTP\s*|status(?:\s+code)?[\s:=]+)(?:403|408|410|425|429|500|502|503|504)\b/i.test(error.message)
    || /fetch failed|unable to connect|timed?\s*out|隧道未连接/i.test(error.message)
}
export type RelayEvent = {
  resource: string; kind: 'playlist' | 'segment'; host: string; status: number; attempt: number
  elapsedMs: number; range?: string; cdnAuth?: string; via?: string
  generation: number
}
type RelayOptions = {
  onResponse?: (event: RelayEvent) => void
  maxAttempts?: number
  /** Re-run the authenticated play request, returning the same track's new playlist. */
  refreshSource?: () => Promise<string>
  maxRefreshes?: number
  onRefresh?: (attempt: number, total: number) => void
  /** Injectable clock for deterministic retry tests. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return }
    const abort = () => { clearTimeout(timer); reject(new Error('aborted')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Keep signed absolute URLs byte-for-byte; only resolve relative references. */
export function hlsAbsoluteUrl(value: string, base: string): string {
  const url = /^https?:\/\//i.test(value) ? value : new URL(value, base).href
  if (!/^https?:\/\//i.test(url)) throw new Error('HLS 资源必须使用 HTTP(S)')
  return url
}

/** Youku's Wasu CDN rotates a 24/25-hex authorization directory on play refresh.
 * The rest of the path (asset id, track and segment number) identifies content.
 * Other hosts retain the entire path; never generally match by basename.
 */
export function hlsContentPath(value: string): string {
  const url = new URL(value)
  if (url.hostname.endsWith('.cp12.wasu.tv')) return url.pathname.replace(/^\/[a-f\d]{24,25}\//i, '/')
  return url.pathname
}

export function rewriteHls(text: string, base: string, register: (resource: Resource) => string, clear = false): string {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('源地址没有返回 HLS 播放列表')
  let variant = false
  return text.split(/\r?\n/).flatMap(raw => {
    const line = raw.trim()
    if (clear && /^#EXT-X-(?:SESSION-)?KEY:/.test(line)) return []
    if (!line || line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) variant = true
      const playlist = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT):/.test(line)
      return [line.replace(/URI="([^"]+)"/g, (_, uri: string) => `URI="${register({ url: hlsAbsoluteUrl(uri, base), playlist })}"`)]
    }
    const playlist = variant
    variant = false
    return [register({ url: hlsAbsoluteUrl(line, base), playlist })]
  }).join('\n')
}

/** RE parses/downloads from loopback; the existing JS fetch stack alone talks
 * to the CDN. This keeps UA, redirect, DNS, TLS and proxy behavior consistent
 * with the original Node/Bun downloader without changing system settings.
 */
export async function createHlsRelay(source: string, headers: Record<string, string>, clear = false, options: RelayOptions = {}): Promise<{
  url: string
  close: () => Promise<void>
  error: () => Error | undefined
  waitForRefresh: () => Promise<void>
  stats: () => { peakConcurrentRequests: number; refreshes: number; refreshElapsedMs: number }
}> {
  const sourceUrl = hlsAbsoluteUrl(source, source)
  const maxAttempts = options.maxAttempts ?? 5
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 21) throw new Error('无效分片重试次数')
  const capability = randomBytes(24).toString('hex')
  const resources = new Map<string, Resource>()
  const ids = new Map<string, string>()
  const active = new Set<AbortController>()
  let peakConcurrentRequests = 0, refreshes = 0, refreshElapsedMs = 0
  const lifetime = new AbortController()
  let generation = 0
  let refreshInFlight: Promise<number> | undefined
  let fatal: Error | undefined
  let rootUrl = sourceUrl
  let rootText = ''
  let shape = ''
  let members: Resource[] = []
  const maxRefreshes = options.maxRefreshes ?? 10
  if (!Number.isInteger(maxRefreshes) || maxRefreshes < 1 || maxRefreshes > 20) throw new Error('无效重新取链次数')
  const started = Date.now()
  let base = '', serial = 0
  const register = (resource: Resource) => {
    const key = `${resource.playlist ? 'p' : 'b'}:${resource.url}`
    let id = ids.get(key)
    if (!id) {
      id = String(serial++) + (resource.playlist ? '.m3u8' : '.bin')
      resources.set(id, resource)
      ids.set(key, id)
    }
    return `${base}/${capability}/${id}`
  }
  const snapshot = (text: string, url: string) => {
    const entries: Resource[] = []
    const structure = rewriteHls(text, url, r => { entries.push(r); return `resource-${entries.length}` }, clear)
    if (entries.some(r => r.playlist) || !text.includes('#EXT-X-ENDLIST')) {
      throw new Error('分片续传需要固定的独立 VOD 播放列表')
    }
    return { entries, structure }
  }
  const root = { url: sourceUrl, playlist: true }
  const rootAddress = () => register(root)
  const setInitialPlaylist = (text: string, url: string) => {
    const parsed = snapshot(text, url)
    shape = parsed.structure
    members = parsed.entries.map(r => {
      const address = register(r)
      return resources.get(address.slice(address.lastIndexOf('/') + 1))!
    })
    rootText = rewriteHls(text, url, register, clear)
  }
  const refresh = async (observedGeneration: number, usedAttempts: number): Promise<number> => {
    if (fatal) throw fatal
    if (generation !== observedGeneration) return 0
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        const refreshStarted = Date.now()
        try {
          for (let attempt = usedAttempts + 1; attempt <= maxRefreshes; attempt++) {
            if (lifetime.signal.aborted) throw new Error('aborted')
            options.onRefresh?.(attempt, maxRefreshes)
            // Reissuing play/playlist after a transient failure consumes the
            // same per-fragment budget as replacing a rejected signed URL.
            if (attempt > 1) await (options.wait ?? waitForRetry)(Math.min(1000 * (attempt - 1), 5000), lifetime.signal)
            refreshes++
            try {
              const next = hlsAbsoluteUrl(await options.refreshSource!(), rootUrl)
              if (lifetime.signal.aborted) throw new Error('aborted')
              const response = await fetch(next, { headers, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(45000)]) })
              if (!response.ok) { await response.body?.cancel(); throw new Error(`重新取链播放列表 HTTP ${response.status}`) }
              const text = await response.text()
              const parsed = snapshot(text, response.url || next)
              // Never mix a new edition, timeline, init, byte range or segment
              // order with downloaded bytes. Only host/signatures may vary.
              if (parsed.structure !== shape || parsed.entries.length !== members.length || parsed.entries.some((r, i) =>
                r.playlist !== members[i]!.playlist || hlsContentPath(r.url) !== hlsContentPath(members[i]!.url))) {
                throw new HlsRefreshError('重新取链后分片结构或内容标识改变，已保留下载进度并停止，避免混入不同片源')
              }
              parsed.entries.forEach((r, i) => { members[i]!.url = r.url })
              root.url = rootUrl = next
              generation++
              return attempt - usedAttempts
            } catch (e) {
              if (lifetime.signal.aborted || !isTransientRefreshError(e) || attempt === maxRefreshes) throw e
            }
          }
          throw new HlsRefreshError('重新取链次数已耗尽，下载进度已保留')
        } finally {
          refreshElapsedMs += Date.now() - refreshStarted
        }
      })().catch(e => {
        fatal = new HlsRefreshError(e instanceof Error ? e.message : String(e))
        throw fatal
      }).finally(() => { refreshInFlight = undefined })
    }
    return await refreshInFlight
  }
  const server = createServer(async (req, res) => {
    const prefix = `/${capability}/`
    const id = req.url?.startsWith(prefix) ? req.url.slice(prefix.length) : ''
    const resource = resources.get(id)
    if (!resource) { res.writeHead(404).end(); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return }
    if (fatal) { res.writeHead(502).end('Source refresh failed'); return }
    if (resource === root && rootText && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end(rootText)
      return
    }
    const abort = new AbortController()
    active.add(abort)
    peakConcurrentRequests = Math.max(peakConcurrentRequests, active.size)
    const timeout = setTimeout(() => abort.abort(), options.refreshSource ? 300_000 : 100_000)
    const disconnected = () => { if (!res.writableFinished) abort.abort() }
    res.on('close', disconnected)
    try {
      const requestHeaders = { ...headers }
      if (req.headers.range) requestHeaders.Range = req.headers.range
      // With refreshSource, a CDN denial replaces the signed source before
      // retrying this same local resource. RE's segment index stays stable.
      let upstream: Response | undefined
      let refreshCount = 0
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          if (refreshInFlight) await refreshInFlight
          const observedGeneration = generation
          const requestUrl = resource.url
          upstream = await fetch(requestUrl, { method: req.method, headers: requestHeaders, signal: abort.signal })
          options.onResponse?.({ resource: id, kind: resource.playlist ? 'playlist' : 'segment', host: new URL(requestUrl).hostname,
            status: upstream.status, attempt, generation: observedGeneration, elapsedMs: Date.now() - started,
            ...(upstream.headers.get('x-oss-cdn-auth') ? { cdnAuth: upstream.headers.get('x-oss-cdn-auth')! } : {}),
            ...(upstream.headers.get('via') ? { via: upstream.headers.get('via')!.slice(0,300) } : {}),
            ...(req.headers.range ? { range: req.headers.range } : {}) })
          if ((upstream.status === 403 || upstream.status === 410) && options.refreshSource && resource !== root) {
            await upstream.body?.cancel()
            if (refreshCount >= maxRefreshes) {
              fatal = new HlsRefreshError(`失败分片重新取 CDN 链接 ${maxRefreshes} 次后仍返回 ${upstream.status}；下载进度已保留`)
              throw fatal
            }
            refreshCount += await refresh(observedGeneration, refreshCount)
            attempt-- // fresh-URL budget is separate from transport retries
            continue
          }
          if (upstream.ok || ![403, 408, 410, 425, 429, 500, 502, 503, 504].includes(upstream.status) || attempt === maxAttempts) break
          await upstream.body?.cancel()
        } catch (e) {
          if (fatal || abort.signal.aborted || attempt === maxAttempts) throw e
          upstream = undefined
        }
        await (options.wait ?? waitForRetry)(Math.min(500 * 2 ** (attempt - 1), 8000), abort.signal)
      }
      if (!upstream) throw new Error('CDN request failed')
      if (!upstream.ok) {
        await upstream.body?.cancel()
        res.writeHead(upstream.status, { 'Content-Type': 'text/plain' }).end(`CDN HTTP ${upstream.status}`)
        return
      }
      if (resource.playlist && req.method !== 'HEAD') {
        const input = await upstream.text()
        if (resource === root && options.refreshSource) setInitialPlaylist(input, upstream.url || resource.url)
        const text = rootText || rewriteHls(input, upstream.url || resource.url, register, clear)
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': Buffer.byteLength(text) }).end(text)
        return
      }
      // fetch decompresses responses. Never forward compressed byte lengths
      // or Content-Encoding for the decoded stream.
      const responseHeaders: Record<string, string> = { 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream' }
      for (const name of ['content-range', 'accept-ranges']) {
        const value = upstream.headers.get(name)
        if (value) responseHeaders[name] = value
      }
      const length = upstream.headers.get('content-length')
      if (length && !upstream.headers.get('content-encoding')) responseHeaders['Content-Length'] = length
      res.writeHead(upstream.status, responseHeaders)
      if (req.method === 'HEAD' || !upstream.body) { res.end(); return }
      await pipeline(Readable.fromWeb(upstream.body as unknown as NodeWebReadableStream), res)
    } catch {
      if (!res.headersSent && !res.destroyed) res.writeHead(502, { 'Content-Type': 'text/plain' }).end('CDN request failed')
      else res.destroy()
    } finally {
      clearTimeout(timeout)
      res.off('close', disconnected)
      active.delete(abort)
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法启动本机 HLS 转发')
  base = `http://127.0.0.1:${address.port}`
  return {
    url: rootAddress(),
    error: () => fatal,
    waitForRefresh: async () => { await refreshInFlight; if (fatal) throw fatal },
    stats: () => ({ peakConcurrentRequests, refreshes, refreshElapsedMs }),
    close: () => new Promise<void>(resolve => {
      lifetime.abort()
      for (const abort of active) abort.abort()
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}
