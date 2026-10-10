import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { HttpsProxyAgent } from 'https-proxy-agent'

/** IQ login/playback CONNECT preserves manual redirects and gateway-supplied headers. */
export function fetchIQAuthProxy(input: string, init: RequestInit, proxy: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = new URL(input)
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    const headers = new Headers(init.headers)
    for (const name of ['host', 'content-length', 'connection', 'transfer-encoding']) headers.delete(name)
    headers.set('accept-encoding', 'identity')
    const agent = new HttpsProxyAgent(proxy)
    const req = request(url, {
      method: init.method || 'GET', headers: Object.fromEntries(headers), agent, signal: init.signal ?? undefined,
    })
    req.once('error', error => { agent.destroy(); reject(error) })
    req.once('response', async incoming => {
      try {
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item)
          else if (value !== undefined) responseHeaders.set(name, value)
        }
        // A source may compress even when identity is requested; match fetch's decoded body.
        const encoding = String(incoming.headers['content-encoding'] || '').toLowerCase()
        const decode = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress()
          : encoding === 'deflate' ? createInflate() : undefined
        if (decode) incoming.once('error', error => decode.destroy(error))
        const stream = decode ? incoming.pipe(decode) : incoming
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of stream) {
          const bytes = Buffer.from(chunk)
          size += bytes.length
          if (size > 6 << 20) throw new Error('IQ 接口响应超过隧道大小限制')
          chunks.push(bytes)
        }
        const status = incoming.statusCode || 502
        const empty = init.method === 'HEAD' || [204, 205, 304].includes(status)
        resolve(new Response(empty ? null : new Uint8Array(Buffer.concat(chunks)), { status, headers: responseHeaders }))
      } catch (error) {
        incoming.destroy()
        reject(error)
      } finally { agent.destroy() }
    })
    if (init.body instanceof Uint8Array) req.end(init.body)
    else if (typeof init.body === 'string') req.end(init.body)
    else if (init.body == null) req.end()
    else { req.destroy(); agent.destroy(); reject(new Error('IQ 接口请求正文类型不支持')) }
  })
}
