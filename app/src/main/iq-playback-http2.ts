import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { connect as http2Connect, type ClientHttp2Session } from 'node:http2'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

const MAX_BODY = 6 << 20
const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'content-length'])

/** IQ DASH returns st=502 over HTTP/1.1 for requests that succeed over HTTP/2. */
export function fetchIQPlaybackHTTP2(input: string, init: RequestInit, proxy: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = new URL(input), proxyURL = new URL(proxy)
    if (init.body != null) { reject(new Error('IQ DASH expects a request without a body')); return }
    if (!['http:', 'https:'].includes(proxyURL.protocol)) { reject(new Error('IQ proxy protocol is unsupported')); return }
    let secure: TLSSocket | undefined
    let session: ClientHttp2Session | undefined
    let settled = false
    const finish = (error?: Error, response?: Response) => {
      if (settled) return
      settled = true
      init.signal?.removeEventListener('abort', abort)
      request.destroy()
      session?.destroy()
      secure?.destroy()
      if (error) reject(error)
      else resolve(response!)
    }
    const abort = () => finish(new Error('IQ playback request aborted'))
    const connectHeaders: Record<string, string> = { host: url.host }
    if (proxyURL.username || proxyURL.password) {
      connectHeaders['proxy-authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(proxyURL.username)}:${decodeURIComponent(proxyURL.password)}`).toString('base64')
    }
    const request = (proxyURL.protocol === 'https:' ? httpsRequest : httpRequest)({
      hostname: proxyURL.hostname, port: proxyURL.port || (proxyURL.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT', path: url.hostname + ':' + (url.port || '443'), headers: connectHeaders,
    })
    request.once('error', error => finish(error))
    request.once('connect', (response, socket, head) => {
      if (settled) { socket.destroy(); return }
      if (response.statusCode !== 200) {
        socket.destroy()
        finish(undefined, new Response(null, { status: response.statusCode || 502 }))
        return
      }
      if (head.length) socket.unshift(head)
      secure = tlsConnect({ socket, servername: url.hostname, ALPNProtocols: ['h2'] })
      secure.once('error', error => finish(error))
      secure.once('close', () => finish(new Error('IQ playback TLS connection closed before response')))
      secure.once('secureConnect', () => {
        if (settled) return
        if (secure!.alpnProtocol !== 'h2') { finish(new Error('IQ playback server did not negotiate HTTP/2')); return }
        session = http2Connect(url.origin, { createConnection: () => secure! })
        session.once('error', error => finish(error))
        session.once('close', () => finish(new Error('IQ playback HTTP/2 session closed before response')))
        const headers: Record<string, string> = {
          ':method': init.method || 'GET', ':path': url.pathname + url.search,
          ':scheme': 'https', ':authority': url.host,
        }
        new Headers(init.headers).forEach((value, name) => {
          if (!HOP_HEADERS.has(name)) headers[name] = value
        })
        headers['accept-encoding'] = 'gzip, deflate, br'
        let stream: ReturnType<ClientHttp2Session['request']>
        try { stream = session.request(headers) } catch { finish(new Error('IQ playback HTTP/2 request failed')); return }
        let status = 502
        const responseHeaders = new Headers()
        stream.once('response', incoming => {
          status = Number(incoming[':status']) || 502
          for (const [name, value] of Object.entries(incoming)) {
            if (name.startsWith(':') || value === undefined) continue
            if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, String(item))
            else responseHeaders.set(name, String(value))
          }
        })
        const chunks: Buffer[] = []
        let size = 0
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BODY) { finish(new Error('IQ playback response exceeds tunnel limit')); return }
          chunks.push(chunk)
        })
        stream.once('error', error => finish(error))
        stream.once('aborted', () => finish(new Error('IQ playback HTTP/2 response aborted')))
        stream.once('end', () => {
          if (settled) return
          try {
            let body: Buffer = Buffer.concat(chunks)
            const encoding = responseHeaders.get('content-encoding')?.toLowerCase()
            const options = { maxOutputLength: MAX_BODY }
            if (encoding === 'gzip') body = gunzipSync(body, options)
            else if (encoding === 'br') body = brotliDecompressSync(body, options)
            else if (encoding === 'deflate') body = inflateSync(body, options)
            responseHeaders.delete('content-encoding')
            responseHeaders.delete('content-length')
            const empty = init.method === 'HEAD' || [204, 205, 304].includes(status)
            finish(undefined, new Response(empty ? null : new Uint8Array(body), { status, headers: responseHeaders }))
          } catch { finish(new Error('IQ playback HTTP/2 response invalid')) }
        })
        stream.end()
      })
    })
    if (init.signal?.aborted) { abort(); return }
    init.signal?.addEventListener('abort', abort, { once: true })
    request.end()
  })
}
