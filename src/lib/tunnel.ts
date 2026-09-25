import { randomBytes } from 'node:crypto'
import dns from 'node:dns/promises'
import net from 'node:net'
import tls from 'node:tls'
import { sleep } from './util.ts'

type TunFrame = {
  t: string
  id?: string
  method?: string
  url?: string
  header?: Record<string, string[] | string>
  status?: number
  body?: string
  err?: string
}

type HeaderWS = {
  new (url: string, opts?: { headers?: Record<string, string> }): WebSocket
}

const LIMIT_RE = /429|TUNNEL_LIMITED|CONCURRENCY_LIMITED/
const OCCUPIED = '隧道已被同一个 Key 的另一处占用（每 Key 只允许一条），稍后自动重试'
const KEEPALIVE_MS = 20_000
/** Server text-pings every 2s. Silence longer than this means the process is gone. */
const SILENCE_MS = 8_000
/** Private close code: a newer tunnel for this key took the slot. */
const CLOSE_REPLACED = 4000

export type TunnelStop = { opened: boolean; code: number; reason: string }

export function tunnelRetryWait(stop: TunnelStop, failures: number, message: string): number {
  if (replaced(stop) || LIMIT_RE.test(message)) return 30_000
  if (stop.opened) return 1_000
  return retryDelay(failures, message)
}

function replaced(stop: TunnelStop): boolean {
  return stop.code === CLOSE_REPLACED || /replaced/i.test(stop.reason)
}

/** Backoff after a failed attempt: limits/refusals get a long pause, not 3s. */
function retryDelay(failures: number, message: string): number {
  if (LIMIT_RE.test(message)) return 30_000
  return Math.min(5_000 * 2 ** Math.max(0, failures - 1), 30_000)
}

export function runTunnel(
  host: string,
  key: string,
  onStatus: (ok: boolean, err: string, transport?: 'ws' | 'legacy') => void,
  signal: AbortSignal,
): void {
  const registryKey = Symbol.for('gvs.tunnel.active')
  const registry = globalThis as unknown as Record<symbol, AbortController | undefined>
  registry[registryKey]?.abort()
  const owner = new AbortController()
  registry[registryKey] = owner
  signal = AbortSignal.any([signal, owner.signal])
  const loop = async () => {
    // Every round starts on WebSocket. Legacy is only a handshake fallback
    // for an old gateway — never after a WS session that actually opened,
    // because Upgrade: tunnel through Cloudflare dies in 1–4s and then
    // fights the still-closing WS for the single slot.
    let failures = 0
    while (!signal.aborted) {
      let opened = false
      let transport: 'ws' | 'legacy' = 'ws'
      let lastError = ''
      let stop: TunnelStop = { opened: false, code: 0, reason: '' }
      try {
        stop = await tunnelOnce(host, key, onStatus, signal)
        opened = stop.opened
        transport = 'ws'
        if (replaced(stop)) {
          lastError = OCCUPIED
          onStatus(false, OCCUPIED, 'ws')
        } else if (opened) {
          onStatus(false, 'closed', 'ws')
        }
      } catch (e) {
        if (signal.aborted) return
        lastError = e instanceof Error ? e.message : String(e)
        if (LIMIT_RE.test(lastError)) {
          onStatus(false, OCCUPIED, 'ws')
        } else if (!opened) {
          try {
            await tunnelLegacy(host, key, onStatus, signal)
            opened = true
            transport = 'legacy'
            stop = { opened: true, code: 0, reason: '' }
            lastError = ''
            onStatus(false, 'closed', 'legacy')
          } catch (e2) {
            if (signal.aborted) return
            lastError = e2 instanceof Error ? e2.message : String(e2)
            onStatus(false, LIMIT_RE.test(lastError) ? OCCUPIED : lastError, 'legacy')
          }
        } else {
          onStatus(false, lastError, 'ws')
        }
      }
      failures = opened && !replaced(stop) && !LIMIT_RE.test(lastError) ? 0 : failures + 1
      const wait = tunnelRetryWait(stop, failures, lastError)
      try {
        await sleep(wait, signal)
      } catch {
        return
      }
    }
  }
  void loop()
}

async function tunnelOnce(
  host: string,
  key: string,
  onStatus: (ok: boolean, err: string, transport?: 'ws' | 'legacy') => void,
  signal: AbortSignal,
): Promise<TunnelStop> {
  const u = new URL(host)
  const route = await tunnelRoute(u.hostname)
  signal.throwIfAborted()
  if (route.fakeIp) {
    return tunnelOnceDial(host, key, onStatus, signal, route.tcp)
  }
  return tunnelOnceWS(host, key, onStatus, signal)
}

async function tunnelOnceWS(
  host: string,
  key: string,
  onStatus: (ok: boolean, err: string, transport?: 'ws' | 'legacy') => void,
  signal: AbortSignal,
): Promise<TunnelStop> {
  signal.throwIfAborted()
  const url = tunnelURL(host)
  const WS = WebSocket as unknown as HeaderWS
  const ws = new WS(url, { headers: { Authorization: `Bearer ${key}` } })
  let beat: NodeJS.Timeout | undefined
  let watch: NodeJS.Timeout | undefined
  let opened = false
  let code = 0
  let reason = ''
  let lastRx = Date.now()

  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const fail = (e: unknown) => {
    reject(e instanceof Error ? e : new Error(String(e)))
  }
  const onAbort = () => {
    ws.close()
    fail(new Error('aborted'))
  }
  signal.addEventListener('abort', onAbort, { once: true })
  ws.addEventListener('open', () => {
    if (signal.aborted) { ws.close(); return }
    opened = true
    lastRx = Date.now()
    onStatus(true, '', 'ws')
    beat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      try {
        ws.send(JSON.stringify({ t: 'ping' }))
      } catch {
        /* close path handles this */
      }
    }, KEEPALIVE_MS)
    watch = setInterval(() => {
      if (Date.now() - lastRx < SILENCE_MS) return
      try { ws.close() } catch { /* close event ends the session */ }
    }, 2_000)
  })
  ws.addEventListener('error', () => {
    // After OPEN the close event is the real end. Rejecting here would
    // kick the reconnect loop into the legacy protocol.
    if (!opened) fail(new Error('tunnel websocket error'))
  })
  ws.addEventListener('close', (ev) => {
    code = ev.code
    reason = ev.reason ?? ''
    if (!opened) {
      fail(new Error(`tunnel websocket closed ${ev.code}${ev.reason ? ` ${ev.reason}` : ''}`))
      return
    }
    resolve()
  })
  ws.addEventListener('message', (ev) => {
    lastRx = Date.now()
    void (async () => {
      const text = typeof ev.data === 'string' ? ev.data : await readBlob(ev.data)
      await handleTunText(text, (s) => ws.send(s))
    })()
  })

  try {
    await promise
    return { opened, code, reason }
  } finally {
    if (beat) clearInterval(beat)
    if (watch) clearInterval(watch)
    signal.removeEventListener('abort', onAbort)
    try {
      ws.close()
    } catch {
      /* already closed */
    }
  }
}

/** Clash fake-ip: TCP to 198.18.0.0/15, TLS SNI still the real hostname. */
async function tunnelOnceDial(
  host: string,
  key: string,
  onStatus: (ok: boolean, err: string, transport?: 'ws' | 'legacy') => void,
  signal: AbortSignal,
  tcpHost: string,
): Promise<TunnelStop> {
  const u = new URL(host)
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80)
  const sock = await dial(u.hostname, port, u.protocol === 'https:', signal, tcpHost)
  const key16 = randomBytes(16).toString('base64')
  sock.write(
    `GET /v1/tunnel HTTP/1.1\r\nHost: ${u.host}\r\nAuthorization: Bearer ${key}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key16}\r\n\r\n`,
  )
  let buf = await readHttp101(sock, signal)
  const opened = true
  let code = 0
  let reason = ''
  let lastRx = Date.now()
  onStatus(true, '', 'ws')

  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const send = (text: string) => {
    if (!sock.destroyed) sock.write(wsClientFrame(0x1, Buffer.from(text)))
  }
  const beat = setInterval(() => send(JSON.stringify({ t: 'ping' })), KEEPALIVE_MS)
  const watch = setInterval(() => {
    if (Date.now() - lastRx < SILENCE_MS) return
    sock.destroy()
  }, 2_000)
  const onAbort = () => {
    sock.destroy()
    reject(new Error('aborted'))
  }
  signal.addEventListener('abort', onAbort, { once: true })
  sock.on('error', (e) => reject(e))
  sock.on('end', () => resolve())
  sock.on('close', () => resolve())
  const onChunk = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    const parsed = splitWsFrames(buf)
    buf = parsed.rest
    void (async () => {
      for (const fr of parsed.frames) {
        lastRx = Date.now()
        if (fr.op === 0x8) {
          if (fr.payload.length >= 2) {
            code = fr.payload.readUInt16BE(0)
            reason = fr.payload.subarray(2).toString('utf8')
          }
          sock.destroy()
          return
        }
        if (fr.op === 0x9) {
          if (!sock.destroyed) sock.write(wsClientFrame(0xA, fr.payload))
          continue
        }
        if (fr.op !== 0x1 && fr.op !== 0x2) continue
        await handleTunText(fr.payload.toString('utf8'), send)
      }
    })()
  }
  sock.on('data', onChunk)
  if (buf.length) onChunk(Buffer.alloc(0))
  try {
    await promise
    return { opened, code, reason }
  } finally {
    clearInterval(beat)
    clearInterval(watch)
    signal.removeEventListener('abort', onAbort)
    sock.destroy()
  }
}

async function handleTunText(text: string, send: (s: string) => void): Promise<void> {
  let f: TunFrame
  try {
    f = JSON.parse(text) as TunFrame
  } catch {
    return
  }
  if (f.t === 'ping') {
    send(JSON.stringify({ t: 'pong' }))
    return
  }
  if (f.t !== 'req') return
  send(JSON.stringify(await local(f)))
}

function tunnelURL(host: string): string {
  const u = new URL(host)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/v1/tunnel'
  u.search = ''
  u.hash = ''
  return u.toString()
}

export function isClashFakeIP(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  return a === 198 && (b === 18 || b === 19)
}

type TunnelRoute = { tcp: string, fakeIp: boolean, ttl?: number }

const ROUTE_TTL_MS = 10 * 60_000
/** DoH failed under fake-ip: retry soon instead of pinning Clash egress for 10 min. */
const ROUTE_RETRY_MS = 30_000
const routeCache = new Map<string, { at: number, ttl: number, route: Promise<TunnelRoute> }>()

/**
 * Every tunneled request used to re-resolve its host; under Clash fake-ip that
 * meant a DoH round trip (4s timeout each) per upstream call. Cache per host,
 * sharing the in-flight lookup between concurrent requests.
 */
function tunnelRoute(hostname: string): Promise<TunnelRoute> {
  const hit = routeCache.get(hostname)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.route
  const route = resolveTunnelRoute(hostname)
  const entry = { at: Date.now(), ttl: ROUTE_TTL_MS, route }
  routeCache.set(hostname, entry)
  route.then((r) => { if (r.ttl) entry.ttl = r.ttl }, () => routeCache.delete(hostname))
  return route
}

async function resolveTunnelRoute(hostname: string): Promise<TunnelRoute> {
  if (net.isIP(hostname) || hostname === 'localhost') return { tcp: hostname, fakeIp: false }
  let sys: string[] = []
  try {
    sys = await dns.resolve4(hostname)
  } catch {
    sys = []
  }
  if (!sys.length || !sys.every(isClashFakeIP)) return { tcp: hostname, fakeIp: false }
  const real = (await dohA(hostname)).filter((ip) => !isClashFakeIP(ip))
  if (real[0]) return { tcp: real[0], fakeIp: true }
  return { tcp: hostname, fakeIp: false, ttl: ROUTE_RETRY_MS }
}

async function dohA(hostname: string): Promise<string[]> {
  const urls = [
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
    `https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
  ]
  // Query both resolvers at once: sequential 4s timeouts stacked into 8s stalls.
  try {
    return await Promise.any(urls.map(async (url) => {
      const res = await fetch(url, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(4000),
      })
      if (!res.ok) throw new Error(`doh http ${res.status}`)
      const j = await res.json() as { Answer?: { type: number, data: string }[] }
      const ips = (j.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data)
      if (!ips.length) throw new Error('doh empty')
      return ips
    }))
  } catch {
    return []
  }
}

function wsClientFrame(op: number, payload: Buffer): Buffer {
  const mask = randomBytes(4)
  const len = payload.length
  let hdr: Buffer
  if (len < 126) {
    hdr = Buffer.alloc(6)
    hdr[0] = 0x80 | op
    hdr[1] = 0x80 | len
    mask.copy(hdr, 2)
  } else if (len < 65536) {
    hdr = Buffer.alloc(8)
    hdr[0] = 0x80 | op
    hdr[1] = 0x80 | 126
    hdr.writeUInt16BE(len, 2)
    mask.copy(hdr, 4)
  } else {
    hdr = Buffer.alloc(14)
    hdr[0] = 0x80 | op
    hdr[1] = 0x80 | 127
    hdr.writeBigUInt64BE(BigInt(len), 2)
    mask.copy(hdr, 10)
  }
  const body = Buffer.from(payload)
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3]!
  return Buffer.concat([hdr, body])
}

function splitWsFrames(buf: Buffer): { frames: { op: number, payload: Buffer }[], rest: Buffer } {
  const frames: { op: number, payload: Buffer }[] = []
  let i = 0
  while (buf.length - i >= 2) {
    const b1 = buf[i + 1]!
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let hdr = 2
    if (len === 126) {
      if (buf.length - i < 4) break
      len = buf.readUInt16BE(i + 2)
      hdr = 4
    } else if (len === 127) {
      if (buf.length - i < 10) break
      const n = buf.readBigUInt64BE(i + 2)
      if (n > 8n << 20n) break
      len = Number(n)
      hdr = 10
    }
    const mlen = masked ? 4 : 0
    if (buf.length - i < hdr + mlen + len) break
    let payload = buf.subarray(i + hdr + mlen, i + hdr + mlen + len)
    if (masked) {
      const mk = buf.subarray(i + hdr, i + hdr + 4)
      payload = Buffer.from(payload)
      for (let j = 0; j < payload.length; j++) payload[j] ^= mk[j & 3]!
    } else {
      payload = Buffer.from(payload)
    }
    frames.push({ op: buf[i]! & 0xf, payload })
    i += hdr + mlen + len
  }
  return { frames, rest: buf.subarray(i) }
}

async function local(f: TunFrame): Promise<TunFrame> {
  try {
    const url = new URL(f.url ?? '')
    const route = await tunnelRoute(url.hostname)
    if (route.fakeIp) return await localDial(f, url, route.tcp)
    return await localFetch(f)
  } catch (e) {
    return { t: 'res', id: f.id, err: e instanceof Error ? e.message : String(e) }
  }
}

export async function localFetch(f: TunFrame): Promise<TunFrame> {
  const raw = f.body ? Buffer.from(f.body, 'base64') : undefined
  const headers = new Headers()
  if (f.header) {
    for (const [k, v] of Object.entries(f.header)) {
      if (Array.isArray(v)) for (const x of v) headers.append(k, x)
      else headers.set(k, v)
    }
  }
  const method = f.method || 'GET'
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 40_000)
  let res: Response
  try {
    res = await fetch(f.url ?? '', {
      method,
      redirect: 'manual',
      headers,
      body: method === 'GET' || method === 'HEAD' || !raw?.byteLength ? undefined : new Uint8Array(raw),
      signal: ac.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  const ab = await res.arrayBuffer()
  const slice = ab.byteLength > 6 << 20 ? ab.slice(0, 6 << 20) : ab
  const body = Buffer.from(slice)
  const header: Record<string, string[]> = {}
  res.headers.forEach((val, k) => {
    header[k] = header[k] ? [...header[k], val] : [val]
  })
  const cookies = res.headers.getSetCookie()
  if (cookies.length) header['set-cookie'] = cookies
  return { t: 'res', id: f.id, status: res.status, header, body: body.toString('base64') }
}

/** Clash fake-ip: Bun fetch to 198.18/15 never hits the real Youku MTOP. */
async function localDial(f: TunFrame, url: URL, tcpHost: string): Promise<TunFrame> {
  const method = f.method || 'GET'
  const raw = f.body ? Buffer.from(f.body, 'base64') : Buffer.alloc(0)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 40_000)
  let sock: net.Socket | undefined
  try {
    const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80)
    sock = await dial(url.hostname, port, url.protocol === 'https:', ac.signal, tcpHost)
    const skip: Record<string, true> = { host: true, 'content-length': true, connection: true, 'transfer-encoding': true, 'accept-encoding': true }
    const lines = [`${method} ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.host}`]
    if (f.header) {
      for (const [k, v] of Object.entries(f.header)) {
        if (skip[k.toLowerCase()]) continue
        const vals = Array.isArray(v) ? v : [v]
        for (const x of vals) lines.push(`${k}: ${x}`)
      }
    }
    lines.push('Accept-Encoding: identity', 'Connection: close')
    if (raw.length) lines.push(`Content-Length: ${raw.length}`)
    sock.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (raw.length) sock.write(raw)
    const buf = await readUntilClose(sock, ac.signal)
    const parsed = parseHttpResponse(buf)
    const body = parsed.body.byteLength > 6 << 20 ? parsed.body.subarray(0, 6 << 20) : parsed.body
    return { t: 'res', id: f.id, status: parsed.status, header: parsed.header, body: body.toString('base64') }
  } finally {
    clearTimeout(timer)
    sock?.destroy()
  }
}

function readUntilClose(sock: net.Socket, signal: AbortSignal): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>()
  const chunks: Buffer[] = []
  const onAbort = () => {
    sock.destroy()
    reject(new Error('aborted'))
  }
  signal.addEventListener('abort', onAbort, { once: true })
  sock.on('data', (c: Buffer) => chunks.push(c))
  sock.on('end', () => {
    signal.removeEventListener('abort', onAbort)
    resolve(Buffer.concat(chunks))
  })
  sock.on('error', (e) => {
    signal.removeEventListener('abort', onAbort)
    reject(e)
  })
  sock.on('close', () => {
    signal.removeEventListener('abort', onAbort)
    resolve(Buffer.concat(chunks))
  })
  return promise
}

function parseHttpResponse(buf: Buffer): { status: number, header: Record<string, string[]>, body: Buffer } {
  const idx = buf.indexOf('\r\n\r\n')
  if (idx < 0) return { status: 0, header: {}, body: buf }
  const head = buf.subarray(0, idx).toString('latin1')
  const rest = buf.subarray(idx + 4)
  const lines = head.split('\r\n')
  const status = Number((lines[0] ?? '').split(' ')[1] || 0)
  const header: Record<string, string[]> = {}
  for (const line of lines.slice(1)) {
    const c = line.indexOf(':')
    if (c < 0) continue
    const k = line.slice(0, c).trim()
    const v = line.slice(c + 1).trim()
    const key = k.toLowerCase()
    header[key] = header[key] ? [...header[key], v] : [v]
  }
  let body = rest
  if ((header['transfer-encoding']?.[0] ?? '').toLowerCase().includes('chunked')) {
    body = decodeChunks(rest)
  } else {
    const n = Number(header['content-length']?.[0] ?? '')
    if (Number.isFinite(n) && n >= 0 && n <= rest.length) body = rest.subarray(0, n)
  }
  return { status, header, body }
}

function decodeChunks(buf: Buffer): Buffer {
  const out: Buffer[] = []
  let i = 0
  while (i < buf.length) {
    const nl = buf.indexOf('\r\n', i)
    if (nl < 0) break
    const n = Number.parseInt(buf.subarray(i, nl).toString(), 16)
    if (!Number.isFinite(n) || n < 0) break
    if (n === 0) break
    const start = nl + 2
    const end = start + n
    if (end > buf.length) break
    out.push(buf.subarray(start, end))
    i = end + 2
  }
  return Buffer.concat(out)
}


async function readBlob(data: unknown): Promise<string> {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text()
  return String(data)
}

/**
 * 旧网关协议：裸 TCP/TLS + `Upgrade: tunnel` 劫持，换行分隔 JSON。
 * 线上如果还没升级到 WebSocket 版，走这条。
 */
async function tunnelLegacy(
  host: string,
  key: string,
  onStatus: (ok: boolean, err: string, transport?: 'ws' | 'legacy') => void,
  signal: AbortSignal,
): Promise<void> {
  const u = new URL(host)
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80)
  const route = await tunnelRoute(u.hostname)
  const sock = await dial(u.hostname, port, u.protocol === 'https:', signal, route.tcp)
  sock.write(
    `GET /v1/tunnel HTTP/1.1\r\nHost: ${u.host}\r\nAuthorization: Bearer ${key}\r\nUpgrade: tunnel\r\nConnection: Upgrade\r\n\r\n`,
  )
  let buf = await readHttp101(sock, signal)
  onStatus(true, '', 'legacy')

  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const onAbort = () => {
    sock.destroy()
    reject(new Error('aborted'))
  }
  signal.addEventListener('abort', onAbort, { once: true })
  sock.on('error', reject)
  sock.on('end', () => resolve())
  sock.on('close', () => resolve())
  sock.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    void (async () => {
      while (true) {
        const nl = buf.indexOf(10)
        if (nl < 0) break
        const line = buf.subarray(0, nl).toString().trim()
        buf = buf.subarray(nl + 1)
        if (!line) continue
        let f: TunFrame
        try {
          f = JSON.parse(line) as TunFrame
        } catch {
          continue
        }
        if (f.t === 'ping') {
          sock.write('{"t":"pong"}\n')
          continue
        }
        if (f.t !== 'req') continue
        sock.write(`${JSON.stringify(await local(f))}\n`)
      }
    })()
  })
  return promise.finally(() => {
    signal.removeEventListener('abort', onAbort)
    sock.destroy()
  })
}

function dial(
  hostname: string,
  port: number,
  secure: boolean,
  signal: AbortSignal,
  connectHost = hostname,
): Promise<net.Socket> {
  const { promise, resolve, reject } = Promise.withResolvers<net.Socket>()
  const onAbort = () => reject(new Error('aborted'))
  signal.addEventListener('abort', onAbort, { once: true })
  const raw = net.connect({ host: connectHost, port, timeout: 10_000 }, () => {
    if (!secure) {
      signal.removeEventListener('abort', onAbort)
      resolve(raw)
      return
    }
    const tlsSock = tls.connect({ socket: raw, servername: hostname }, () => {
      signal.removeEventListener('abort', onAbort)
      resolve(tlsSock)
    })
    tlsSock.on('error', reject)
  })
  raw.on('error', reject)
  raw.on('timeout', () => reject(new Error('tunnel dial timeout')))
  return promise
}

function readHttp101(sock: net.Socket, signal: AbortSignal): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>()
  let buf = Buffer.alloc(0)
  const finish = (fn: () => void) => {
    sock.off('data', onData)
    signal.removeEventListener('abort', onAbort)
    clearTimeout(timer)
    fn()
  }
  const onAbort = () => finish(() => reject(new Error('aborted')))
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => finish(() => reject(new Error('tunnel http 无响应'))), 15_000)
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    const idx = buf.indexOf('\r\n\r\n')
    if (idx < 0) return
    const head = buf.subarray(0, idx).toString()
    if (head.includes(' 101 ')) {
      finish(() => resolve(buf.subarray(idx + 4)))
      return
    }
    // 非 101 时把 body 也读出来：TUNNEL_LIMITED / RATE_LIMITED 这类原因在里面。
    const status = head.split('\r\n')[0] ?? head
    const body = buf.subarray(idx + 4).toString().trim()
    if (body.includes('}') || /(TUNNEL_LIMITED|CONCURRENCY|RATE_LIMITED|QUOTA)/.test(body)) {
      finish(() => reject(new Error(`tunnel http ${status} ${body.slice(0, 160)}`)))
    }
  }
  sock.on('data', onData)
  sock.once('error', (e) => finish(() => reject(e)))
  sock.once('close', () => finish(() => reject(new Error('tunnel http 连接被关闭'))))
  return promise
}

