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

export function runTunnel(
  host: string,
  key: string,
  onStatus: (ok: boolean, err: string, transport?: 'ws' | 'legacy') => void,
  signal: AbortSignal,
): void {
  const loop = async () => {
    // Start on websocket — that is what the current gateway speaks and the only
    // upgrade Cloudflare keeps alive. A handshake failure (older gateway, which
    // hijacks a raw `Upgrade: tunnel`) drops us to the legacy protocol instead
    // of leaving the user without a tunnel.
    let transport: 'ws' | 'legacy' = 'ws'
    while (!signal.aborted) {
      try {
        if (transport === 'ws') await tunnelOnce(host, key, onStatus, signal)
        else await tunnelLegacy(host, key, onStatus, signal)
        onStatus(false, 'closed', transport)
      } catch (e) {
        if (signal.aborted) return
        const msg = e instanceof Error ? e.message : String(e)
        if (transport === 'ws') {
          transport = 'legacy'
          onStatus(false, `${msg} · 回退旧隧道协议`, 'legacy')
        } else {
          onStatus(false, msg, 'legacy')
        }
      }
      try {
        await sleep(3000, signal)
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
  const onAbort = () => reject(new Error('aborted'))
  signal.addEventListener('abort', onAbort, { once: true })
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    const idx = buf.indexOf('\r\n\r\n')
    if (idx < 0) return
    sock.off('data', onData)
    signal.removeEventListener('abort', onAbort)
    const head = buf.subarray(0, idx).toString()
    const rest = buf.subarray(idx + 4)
    if (!head.includes(' 101 ')) reject(new Error(`tunnel http ${head.split('\r\n')[0] ?? head}`))
    else resolve(rest)
  }
  sock.on('data', onData)
  sock.once('error', reject)
  return promise
}
