import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { normalizeDesktopProxy, resolveDesktopTunnelProxy } from './desktop-proxy'

test('desktop proxy accepts arbitrary HTTP/HTTPS ports and blank system routing', () => {
  for (const address of ['http://127.0.0.1:7890', 'http://localhost:8080', 'https://proxy.example:8443', 'http://[::1]:8899']) {
    assert.equal(normalizeDesktopProxy(`  ${address}/  `), address)
  }
  assert.equal(normalizeDesktopProxy('   '), '')
  assert.equal(normalizeDesktopProxy('http://proxy.example:80'), 'http://proxy.example')
})

test('desktop proxy rejects PAC URLs, unsupported transports, credentials and malformed ports', () => {
  for (const address of ['127.0.0.1:7890', 'socks5://localhost:1080', 'http://localhost:99999', 'http://localhost:bad',
    'http://localhost/proxy.pac', 'http://localhost?port=7890', 'http://localhost#proxy',
    'http://private-user:private-password@localhost:8080']) {
    assert.throws(() => normalizeDesktopProxy(address), error => error instanceof Error
      && error.message.includes('HTTP/HTTPS') && !error.message.includes('private-password'))
  }
})

test('desktop tunnel prioritizes saved override and keeps localhost direct', async () => {
  let lookups = 0
  const system = async () => { lookups++; return 'PROXY 127.0.0.1:7897; DIRECT' }
  const manual = 'http://127.0.0.1:8899'
  assert.equal(await resolveDesktopTunnelProxy('https://gateway.example', manual, 'http://localhost:7890', system), manual)
  assert.equal(await resolveDesktopTunnelProxy('https://gateway.example', '', 'http://localhost:7890', system), 'http://localhost:7890')
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(await resolveDesktopTunnelProxy(`http://${host}:8080`, manual, '', system), '')
  }
  assert.equal(lookups, 0)
  assert.equal(await resolveDesktopTunnelProxy('https://gateway.example', '', '', system), 'http://127.0.0.1:7897')
  assert.equal(lookups, 1)
})

test('desktop tunnel preserves HTTPS and first PAC decision when override is cleared', async () => {
  const target = 'https://gateway.example'
  assert.equal(await resolveDesktopTunnelProxy(target, '', '', async () => 'HTTPS proxy.example:8443; DIRECT'), 'https://proxy.example:8443')
  assert.equal(await resolveDesktopTunnelProxy(target, '', '', async () => 'DIRECT; PROXY localhost:7897'), '')
  assert.equal(await resolveDesktopTunnelProxy(target, '', '', async () => { throw new Error('no system proxy') }), '')
})
