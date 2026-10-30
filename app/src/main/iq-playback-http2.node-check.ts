import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createSecureServer, type ServerHttp2Stream, type IncomingHttpHeaders } from 'node:http2'
import { connect } from 'node:net'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import type { Duplex } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { fetchIQAuthProxy } from './iq-auth-transport.ts'

const fixtureCert = JSON.parse(readFileSync(new URL('./testdata/iq-http2-local.json', import.meta.url), 'utf8'))

async function fixture(handle: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => void, deny = false) {
  const sockets = new Set<Duplex>()
  const track = (socket: Duplex) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
  }
  let requests = 0, connects = 0
  let proxyAuth = ''
  const origin = createSecureServer({ key: fixtureCert.key, cert: fixtureCert.cert })
  origin.on('connection', track)
  origin.on('session', session => session.on('error', () => {}))
  origin.on('stream', (stream, headers) => {
    requests++
    stream.on('error', () => {})
    handle(stream, headers)
  })
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve))
  const proxy = createServer()
  proxy.on('connect', (req, socket) => {
    connects++
    proxyAuth = String(req.headers['proxy-authorization'] || '')
    assert.equal(req.url, 'cache-video.iq.com:443')
    track(socket)
    if (deny) { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return }
    const upstream = connect((origin.address() as { port: number }).port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      socket.pipe(upstream).pipe(socket)
    })
    track(upstream)
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const previousCAs = getCACertificates('default')
  setDefaultCACertificates([...previousCAs, fixtureCert.cert])
  return {
    proxy: `http://fixture:password@127.0.0.1:${(proxy.address() as { port: number }).port}`,
    requests: () => requests, connects: () => connects, proxyAuth: () => proxyAuth,
    close: async () => {
      setDefaultCACertificates(previousCAs)
      for (const socket of sockets) socket.destroy()
      await Promise.all([new Promise<void>(resolve => origin.close(() => resolve())),
        new Promise<void>(resolve => proxy.close(() => resolve()))])
    },
  }
}

test('IQ DASH negotiates HTTP/2 inside CONNECT and preserves the signed request and decoded response', { timeout: 3000 }, async () => {
  const server = await fixture((stream, headers) => {
    assert.equal(headers[':path'], '/dash?tvid=fixture&vf=a%2Bb%3D&empty=')
    assert.equal(headers[':method'], 'GET')
    assert.equal(headers.pck, 'fixture-session')
    assert.equal(headers['user-agent'], 'fixture-tv')
    assert.equal(headers.connection, undefined)
    stream.respond({ ':status': 200, 'content-encoding': 'gzip', 'set-cookie': ['one=1', 'two=2'] })
    stream.end(gzipSync('{"program":{"video":[{"scrsz":"3840x2160"}]}}'))
  })
  try {
    const response = await fetchIQAuthProxy('https://cache-video.iq.com/dash?tvid=fixture&vf=a%2Bb%3D&empty=', {
      headers: { pck: 'fixture-session', 'User-Agent': 'fixture-tv', Connection: 'close' },
    }, server.proxy)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { program: { video: [{ scrsz: '3840x2160' }] } })
    assert.deepEqual(response.headers.getSetCookie(), ['one=1', 'two=2'])
    assert.equal(response.headers.get('content-encoding'), null)
    assert.equal(server.connects(), 1)
    assert.equal(server.requests(), 1)
    assert.equal(server.proxyAuth(), 'Basic ' + Buffer.from('fixture:password').toString('base64'))
  } finally { await server.close() }
})

test('IQ DASH proxy rejection never contacts the origin', { timeout: 3000 }, async () => {
  const server = await fixture(() => assert.fail('denied proxy reached origin'), true)
  try {
    const response = await fetchIQAuthProxy('https://cache-video.iq.com/dash', {}, server.proxy)
    assert.equal(response.status, 403)
    assert.equal(server.requests(), 0)
    assert.equal(server.connects(), 1)
  } finally { await server.close() }
})

test('IQ DASH cancellation rejects a stalled HTTP/2 response', { timeout: 3000 }, async () => {
  const controller = new AbortController()
  const server = await fixture(() => controller.abort())
  try {
    await assert.rejects(fetchIQAuthProxy('https://cache-video.iq.com/dash', { signal: controller.signal }, server.proxy), /aborted/)
    assert.equal(server.requests(), 1)
  } finally { await server.close() }
})

test('IQ DASH rejects when the origin closes HTTP/2 before sending a response', { timeout: 3000 }, async () => {
  const server = await fixture(stream => stream.session!.destroy())
  try {
    await assert.rejects(fetchIQAuthProxy('https://cache-video.iq.com/dash', {}, server.proxy), /closed|aborted/)
    assert.equal(server.requests(), 1)
  } finally { await server.close() }
})
