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
  const loop = async () => {
    // Every round starts on WebSocket — that is what the gateway speaks and the
    // only upgrade Cloudflare keeps alive. Only when a round fails do we also
    // try the legacy upgrade (older gateway) *in the same round*, so a single
    // transient failure can never downgrade the rest of the session.
    let failures = 0
    let lastError = ''
    while (!signal.aborted) {
      let connected = false
      try {
        await tunnelOnce(host, key, onStatus, signal)
        onStatus(false, 'closed', 'ws')
        connected = true
      } catch (e) {
        if (signal.aborted) return
        lastError = e instanceof Error ? e.message : String(e)
        if (LIMIT_RE.test(lastError)) {
          onStatus(false, OCCUPIED, 'ws')
        } else {
          // The legacy attempt reads the real HTTP status, so its error text is
          // more informative than the WebSocket handshake failure.
          try {
            await tunnelLegacy(host, key, onStatus, signal)
            onStatus(false, 'closed', 'legacy')
            connected = true
          } catch (e2) {
            if (signal.aborted) return
            lastError = e2 instanceof Error ? e2.message : String(e2)
            onStatus(false, LIMIT_RE.test(lastError) ? OCCUPIED : lastError, 'legacy')
          }
        }
      }
      failures = connected ? 0 : failures + 1
      try {
        await sleep(connected ? 3000 : retryDelay(failures, lastError), signal)
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
): Promise<void> {
  const url = tunnelURL(host)
  const WS = WebSocket as unknown as HeaderWS
  const ws = new WS(url, { headers: { Authorization: `Bearer ${key}` } })

  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const fail = (e: unknown) => {
    reject(e instanceof Error ? e : new Error(String(e)))
  }
  const onAbort = () => {
    ws.close()
    fail(new Error('aborted'))
  }
  signal.addEventListener('abort', onAbort, { once: true })
  ws.addEventListener('open', () => onStatus(true, '', 'ws'))
  ws.addEventListener('error', () => fail(new Error('tunnel websocket error')))
  ws.addEventListener('close', () => resolve())
  ws.addEventListener('message', (ev) => {
    void (async () => {
      const text = typeof ev.data === 'string' ? ev.data : await readBlob(ev.data)
      let f: TunFrame
      try {
        f = JSON.parse(text) as TunFrame
      } catch {
        return
      }
      if (f.t === 'ping') {
        ws.send(JSON.stringify({ t: 'pong' }))
        return
      }
      if (f.t !== 'req') return
      ws.send(JSON.stringify(await local(f)))
    })()
  })

  return promise.finally(() => {
    signal.removeEventListener('abort', onAbort)
    try {
      ws.close()
    } catch {
      /* already closed */
    }
  })
}

function tunnelURL(host: string): string {
  const u = new URL(host)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/v1/tunnel'
  u.search = ''
  u.hash = ''
  return u.toString()
}

async function local(f: TunFrame): Promise<TunFrame> {
  try {
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
    return { t: 'res', id: f.id, status: res.status, header, body: body.toString('base64') }
  } catch (e) {
    return { t: 'res', id: f.id, err: e instanceof Error ? e.message : String(e) }
  }
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
  const sock = await dial(u.hostname, port, u.protocol === 'https:', signal)
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

function dial(hostname: string, port: number, secure: boolean, signal: AbortSignal): Promise<net.Socket> {
  const { promise, resolve, reject } = Promise.withResolvers<net.Socket>()
  const onAbort = () => reject(new Error('aborted'))
  signal.addEventListener('abort', onAbort, { once: true })
  const raw = net.connect({ host: hostname, port, timeout: 10_000 }, () => {
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
