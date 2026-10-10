import { expect, test } from 'bun:test'
import { createIQSourceRoute, isIQAuthURL, isIQSourceURL } from '../../app/src/main/iq-auth-proxy.ts'
import { runTunnel, setTunnelFetchRoute } from './tunnel.ts'

test('IQ authentication identification remains distinct from playback routing', () => {
  for (const url of ['https://passport.iq.com/apis/login', 'https://intl-passport.iqiyi.com/apis/login']) {
    expect(isIQAuthURL(new URL(url))).toBe(true)
  }
  for (const url of ['https://www.iq.com/', 'https://video.iq.com/', 'https://passport.iq.com.example.test/',
    'https://youku.com/', 'http://passport.iq.com/', 'https://user:pass@passport.iq.com/']) {
    expect(isIQAuthURL(new URL(url))).toBe(false)
  }
})

test('IQ source routing matches overseas rules and excludes other providers and lookalike domains', async () => {
  for (const url of ['https://passport.iq.com/apis/login', 'https://intl-passport.iqiyi.com/apis/login',
    'https://iq.com/', 'https://www.iq.com/', 'https://video.iq.com/', 'https://inter.iqiyi.com/',
    'https://cache.inter.iqiyi.com/dash', 'https://video.iqiyi.com/', 'https://cache.video.iqiyi.com/dash']) {
    expect(isIQSourceURL(new URL(url))).toBe(true)
  }
  let resolved = 0
  const route = createIQSourceRoute({ resolveProxy: async () => { resolved++; return 'PROXY 127.0.0.1:7897' },
    log: () => {}, fetch: async () => { throw new Error('must not proxy an unrelated request') },
  })
  for (const url of ['https://iqiyi.com/', 'https://cache.video.iqiyi.com.example.test/',
    'https://fake-inter.iqiyi.com/', 'https://fake-iq.com/', 'https://intl-passport.iqiyi.com.example.test/',
    'http://118.26.120.37/dash', 'https://118.26.120.37/dash',
    'https://118.26.120.38/', 'https://118.26.120.37.example.test/', 'https://youku.com/',
    'https://v.qq.com/', 'https://user:pass@inter.iqiyi.com/', 'ftp://video.iqiyi.com/']) {
    expect(isIQSourceURL(new URL(url))).toBe(false)
    expect(await route(new URL(url))).toBeUndefined()
  }
  expect(resolved).toBe(0)
})

for (const [host, protocol, label] of [
  ['intl-passport.iqiyi.com', 'https:', 'iq_auth_transport'],
  ['cache.inter.iqiyi.com', 'https:', 'iq_source_transport'],
  ['cache.video.iqiyi.com', 'https:', 'iq_source_transport'],
  ['video.iq.com', 'https:', 'iq_source_transport'],
]) test(`IQ ${host} tunnel uses the PAC proxy and preserves POST, headers and redirects`, async () => {
  const logs: string[] = []
  let requests = 0
  const target = `${protocol}//${host}/playback?token=PRIVATE_QUERY`
  const route = createIQSourceRoute({
    resolveProxy: async url => { expect(url).toBe(target); return 'PROXY 127.0.0.1:7897; DIRECT' },
    log: line => logs.push(line),
    fetch: async (url, init, proxy) => {
      requests++
      expect(url).toBe(target)
      expect(init.method).toBe('POST')
      expect(init.redirect).toBe('manual')
      expect(new Headers(init.headers).get('cookie')).toBe('I00001=PRIVATE_COOKIE')
      expect(new Headers(init.headers).get('user-agent')).toBe('fixture-device')
      expect(new TextDecoder().decode(init.body as Uint8Array)).toBe('password=PRIVATE_PASSWORD')
      expect(init.credentials).toBe('omit')
      expect(proxy).toBe('http://127.0.0.1:7897')
      const headers = new Headers({ location: '/next' })
      headers.append('set-cookie', 'first=1; Path=/')
      headers.append('set-cookie', 'second=2; Path=/')
      return new Response('fixture', { status: 302, headers })
    },
  })
  setTunnelFetchRoute(route)
  const abort = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let receive!: (frame: Record<string, any>) => void
  const received = new Promise<Record<string, any>>((resolve, reject) => {
    receive = resolve
    timeout = setTimeout(() => reject(new Error('IQ routed tunnel request timed out')), 3000)
  })
  const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response('upgrade required', { status: 426 }) },
    websocket: {
      open(ws) { ws.send(JSON.stringify({ t: 'req', id: 'fixture', method: 'POST',
        url: target, header: { Cookie: 'I00001=PRIVATE_COOKIE', 'User-Agent': 'fixture-device' },
        body: Buffer.from('password=PRIVATE_PASSWORD').toString('base64') })) },
      message(_ws, message) { const frame = JSON.parse(String(message)); if (frame.t === 'res') receive(frame) },
    },
  })
  try {
    runTunnel(gateway.url.toString(), 'fixture-key', () => {}, abort.signal)
    const frame = await received
    expect(requests).toBe(1)
    expect(frame.status).toBe(302)
    expect(frame.header['set-cookie']).toHaveLength(2)
    expect(frame.header.location).toEqual(['/next'])
    expect(Buffer.from(frame.body, 'base64').toString()).toBe('fixture')
    expect(logs.join('\n')).not.toContain('PRIVATE_')
    expect(logs.join('\n')).toContain(`${label} host=${host} route=system-proxy http=302`)
    expect(logs.join('\n')).not.toContain('/playback')
  } finally {
    clearTimeout(timeout)
    abort.abort()
    await Bun.sleep(10)
    gateway.stop(true)
    setTunnelFetchRoute(undefined)
  }
})

test('IQ proxy failures do not retry direct', async () => {
  const logs: string[] = []
  let calls = 0
  const route = createIQSourceRoute({ resolveProxy: async () => 'PROXY 127.0.0.1:7897; DIRECT', log: line => logs.push(line),
    fetch: async () => { calls++; throw new Error('fixture failure') },
  })
  const target = 'https://cache.video.iqiyi.com/dash'
  const fetcher = await route(new URL(target))
  await expect(fetcher!(target, {})).rejects.toThrow('fixture failure')
  expect(calls).toBe(1)
  expect(logs.join('\n')).toContain('iq_source_transport host=cache.video.iqiyi.com route=system-proxy failed')
  expect(await route(new URL('https://youku.com/'))).toBeUndefined()
})

test('DIRECT PAC decisions retain the existing fake-IP-safe tunnel transport', async () => {
  const logs: string[] = []
  const route = createIQSourceRoute({ resolveProxy: async () => 'DIRECT; PROXY 127.0.0.1:7897',
    log: line => logs.push(line), fetch: async () => { throw new Error('must not override direct transport') },
  })
  expect(await route(new URL('https://passport.iq.com/login'))).toBeUndefined()
  expect(await route(new URL('https://cache.video.iqiyi.com/dash'))).toBeUndefined()
  expect(logs.join('\n')).toContain('route=direct')
})

test('IQ playback HTTPS proxy decisions retain the HTTPS CONNECT endpoint', async () => {
  const target = 'https://cache.inter.iqiyi.com/dash'
  const route = createIQSourceRoute({ resolveProxy: async () => 'HTTPS 127.0.0.1:8443; DIRECT', log: () => {},
    fetch: async (_url, _init, proxy) => { expect(proxy).toBe('https://127.0.0.1:8443'); return new Response('ok') },
  })
  const fetcher = await route(new URL(target))
  expect(await (await fetcher!(target, {})).text()).toBe('ok')
})

test('IQ uses a changing desktop proxy override without resolving PAC or changing domestic/CDN routes', async () => {
  let configured = 'http://127.0.0.1:8899'
  let lookups = 0
  const proxies: string[] = []
  const logs: string[] = []
  const route = createIQSourceRoute({ configuredProxy: () => configured,
    resolveProxy: async () => { lookups++; return 'DIRECT' }, log: line => logs.push(line),
    fetch: async (_url, _init, proxy) => { proxies.push(proxy); return new Response('ok') },
  })
  const target = 'https://cache.inter.iqiyi.com/dash?token=PRIVATE_QUERY'
  for (const proxy of ['http://127.0.0.1:8899', 'https://proxy.example:8443']) {
    configured = proxy
    const fetcher = await route(new URL(target))
    expect(await (await fetcher!(target, {})).text()).toBe('ok')
  }
  expect(proxies).toEqual(['http://127.0.0.1:8899', 'https://proxy.example:8443'])
  expect(lookups).toBe(0)
  for (const url of ['https://cache.video.iqiyi.com.example.test/', 'https://cache.iqiyi.com/dash',
    'https://data.video.qiyi.com/', 'https://pic1.iqiyipic.com/', 'https://v.qq.com/']) {
    expect(await route(new URL(url))).toBeUndefined()
  }
  expect(lookups).toBe(0)
  configured = ''
  expect(await route(new URL(target))).toBeUndefined()
  expect(lookups).toBe(1)
  expect(logs.join('\n')).toContain('route=configured-proxy http=200')
  expect(logs.join('\n')).not.toContain('PRIVATE_')
})

test('an unavailable desktop IQ proxy does not fall back to system or direct', async () => {
  let calls = 0
  const route = createIQSourceRoute({ configuredProxy: () => 'http://localhost:8899',
    resolveProxy: async () => { throw new Error('must not consult PAC') }, log: () => {},
    fetch: async () => { calls++; throw new Error('proxy unavailable') },
  })
  const target = 'https://passport.iq.com/login'
  const fetcher = await route(new URL(target))
  await expect(fetcher!(target, {})).rejects.toThrow('proxy unavailable')
  expect(calls).toBe(1)
})
