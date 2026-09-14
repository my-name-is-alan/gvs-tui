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

export function runTunnel(
  host: string,
  key: string,
  onStatus: (ok: boolean, err: string) => void,
  signal: AbortSignal,
): void {
  const loop = async () => {
    while (!signal.aborted) {
      try {
        await tunnelOnce(host, key, onStatus, signal)
        onStatus(false, 'closed')
      } catch (e) {
        if (signal.aborted) return
        onStatus(false, e instanceof Error ? e.message : String(e))
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
  onStatus: (ok: boolean, err: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const u = new URL(host)
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80)
  const sock = await dial(u.hostname, port, u.protocol === 'https:', signal)
  const req = `GET /v1/tunnel HTTP/1.1\r\nHost: ${u.host}\r\nAuthorization: Bearer ${key}\r\nUpgrade: tunnel\r\nConnection: Upgrade\r\n\r\n`
  sock.write(req)
  const rest = await readHttp101(sock, signal)
  onStatus(true, '')
  let buf = rest
  const local = async (f: TunFrame): Promise<TunFrame> => {
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
        const out = await local(f)
        sock.write(`${JSON.stringify(out)}\n`)
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
