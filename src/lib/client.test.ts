import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GwClient } from './client'
import type { FileConfig } from './config'
import { fetchGateway, fetchRemote, isProxyEnvKey } from './proxy'

let originalProxy: string | undefined
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined
beforeEach(() => {
  originalProxy = process.env.GVS_PROXY
  delete process.env.GVS_PROXY
})
afterEach(() => {
  fetchSpy?.mockRestore()
  fetchSpy = undefined
  if (originalProxy === undefined) delete process.env.GVS_PROXY
  else process.env.GVS_PROXY = originalProxy
})

test('gateway rate rejection preserves status, machine code and Retry-After for descriptor retry', async () => {
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () =>
    Response.json({ code: 429, error_code: 'RATE_LIMITED', msg: '操作太频繁，请稍等片刻再试。' }, { status: 429, headers: { 'Retry-After': '2' } }),
  { preconnect: fetch.preconnect }))
  const client = new GwClient('https://gateway.example', 'test-key')
  await expect(client.invoke('iqcn', 'download-segment', { planId: 'fixture', index: 8 })).rejects.toMatchObject({
    httpStatus: 429, errorCode: 'RATE_LIMITED', retryAfterMs: 2000,
  })
})

test('gateway API uses the saved proxy for authentication and takes edits on the next request', async () => {
  const routes: unknown[] = []
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    routes.push((init as RequestInit & { proxy?: string })?.proxy)
    return Response.json({ code: 0, data: { id: 'key' } })
  }, { preconnect: fetch.preconnect }))
  const cfg = { gatewayProxy: 'http://localhost:7897' }
  const client = new GwClient('https://gateway.example', 'test-key', () => cfg.gatewayProxy)
  expect((await client.keyInfo()).id).toBe('key')
  cfg.gatewayProxy = 'http://localhost:7898'
  await client.keyInfo()
  cfg.gatewayProxy = ''
  await client.keyInfo()
  expect(routes).toEqual(['http://localhost:7897', 'http://localhost:7898', undefined])
})

test('Tencent job clients retain fixed and live proxy routes through nested forks', async () => {
  const routes: unknown[] = []
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    routes.push((init as RequestInit & { proxy?: string })?.proxy)
    return Response.json({ code: 0, data: { id: 'key' } })
  }, { preconnect: fetch.preconnect }))
  const fixed = new GwClient('https://gateway.example', 'key', 'http://localhost:7897')
  await fixed.forkTencentJob(1, 'episode-1').keyInfo()
  const cfg = { gatewayProxy: 'http://localhost:7898' } as FileConfig
  for (const source of [() => cfg.gatewayProxy, () => cfg]) {
    const parent = new GwClient('https://gateway.example', 'key', source)
    const child = parent.forkTencentJob(2, 'episode-2').forkTencentJob(3, 'episode-3')
    cfg.gatewayProxy = 'http://localhost:7898'
    await child.keyInfo()
    cfg.gatewayProxy = 'http://localhost:7899'
    await child.keyInfo()
    cfg.gatewayProxy = ''
    await child.keyInfo()
  }
  expect(routes).toEqual([
    'http://localhost:7897',
    'http://localhost:7898', 'http://localhost:7899', undefined,
    'http://localhost:7898', 'http://localhost:7899', undefined,
  ])
})

test('environment override wins, local gateways bypass proxy, and unrelated requests stay separate', async () => {
  const routes: unknown[] = []
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    routes.push((init as RequestInit & { proxy?: string })?.proxy)
    return Response.json({ code: 0, data: {} })
  }, { preconnect: fetch.preconnect }))
  process.env.GVS_PROXY = 'http://localhost:8888'
  await new GwClient('https://gateway.example', 'key', 'http://localhost:7897').keyInfo()
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    await new GwClient(`http://${host}:8080`, 'key', 'http://localhost:7897').keyInfo()
  }
  delete process.env.GVS_PROXY
  await fetchRemote('https://api.tmdb.org/test')
  expect(routes).toEqual(['http://localhost:8888', undefined, undefined, undefined, undefined])
})

test('a failed gateway proxy makes no direct retry and does not expose proxy credentials', async () => {
  fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('failed via http://user:private-secret@localhost:7897'))
  await expect(fetchGateway('https://gateway.example/v1/key', {}, 'http://user:private-secret@localhost:7897'))
    .rejects.toThrow(/^无法通过代理连接网关，请检查代理是否运行及分流规则（F4 → 连接 → 网关代理）$/)
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  await expect(fetchGateway('https://gateway.example/v1/key', {}, 'http://localhost/proxy.pac'))
    .rejects.toThrow('HTTP/HTTPS')
  expect(fetchSpy).toHaveBeenCalledTimes(1)
})

test('HTTP denial is returned intact; aborts do not retry', async () => {
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('blocked', { status: 403 }))
  expect((await fetchGateway('https://gateway.example', {}, 'http://localhost:7897')).status).toBe(403)
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  const abort = new DOMException('aborted', 'AbortError')
  fetchSpy.mockRejectedValue(abort)
  await expect(fetchGateway('https://gateway.example', {}, 'http://localhost:7897')).rejects.toBe(abort)
  expect(fetchSpy).toHaveBeenCalledTimes(2)
})

test('Electron business calls bind, submit measured events and stop before retrying a rejected job', async () => {
  const requests: Array<{ action: string; input: Record<string, unknown> }> = []
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = JSON.parse(String(init?.body))
    requests.push(request)
    const data = request.input.report_type === 'bind'
      ? { binding: 'fixture-binding', observation_sources: ['electron_process'] }
      : request.input.report_type === 'observe'
        ? { status: 'observed_locally', sent: false }
        : request.input.vid === 'denied' ? { em: 93 } : { em: 0, has_url: true }
    return Response.json({ code: 0, data })
  }, { preconnect: fetch.preconnect }))
  const cfg = { tencentMode: 'tv', tencentObservations: true } as FileConfig
  const client = new GwClient('https://gateway.example', 'key', () => cfg, 'electron_process')
  await client.invoke('tencent', 'play', { vid: 'episode1', session_type: 'tv' })
  expect(requests.map(r => r.input.report_type || r.action)).toEqual(['bind', 'observe', 'play', 'observe'])
  expect(requests[2]!.input.report_binding).toBe('fixture-binding')
  expect(JSON.parse(String(requests[1]!.input.payload)).source).toBe('electron_process')
  const job = client.forkTencentJob(123, 'denied')
  await expect(job.invoke('tencent', 'play', { vid: 'denied', session_type: 'tv' })).rejects.toThrow('停止')
  const before = requests.length
  await expect(job.invoke('tencent', 'play', { vid: 'denied', session_type: 'tv' })).rejects.toThrow('stopped')
  expect(requests).toHaveLength(before)
})

test('search continues when the gateway has no tencent report action', async () => {
  const actions: string[] = []
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = JSON.parse(String(init?.body))
    actions.push(request.action)
    if (request.action === 'report') {
      return Response.json({ code: 400, msg: 'INVALID_PARAM: tencent action "report" (see capabilities)' }, { status: 400 })
    }
    return Response.json({ code: 0, data: { list: [{ title: '剧' }] } })
  }, { preconnect: fetch.preconnect }))
  const client = new GwClient('https://gateway.example', 'key', () => ({ tencentMode: 'tv', tencentObservations: true }) as FileConfig)
  const first = await client.invoke('tencent', 'search', { q: '剧名' })
  const second = await client.invoke('tencent', 'search', { q: '另一部' })
  expect(first).toEqual({ list: [{ title: '剧' }] })
  expect(second).toEqual({ list: [{ title: '剧' }] })
  expect(actions).toEqual(['report', 'search', 'search'])
})

test('a fresh process loads the saved gateway proxy without any proxy environment variable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-gateway-proxy-'))
  const requests: string[] = []
  const proxy = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(req) {
      requests.push(req.url)
      return Response.json({ code: 0, data: { id: 'persisted-proxy' } })
    },
  })
  try {
    mkdirSync(join(dir, 'gvs'))
    writeFileSync(join(dir, 'gvs', 'tui.json'), JSON.stringify({
      host: 'http://gateway.invalid', key: 'test-key', gatewayProxy: `http://127.0.0.1:${proxy.port}`,
    }))
    const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !isProxyEnvKey(k) && !['GVS_PROXY', 'GVS_HOST', 'GVS_KEY', 'APPDATA', 'NO_PROXY', 'no_proxy'].includes(k))) as Record<string, string>
    const child = Bun.spawn([process.execPath, '--eval', `
      import { loadConfig } from './src/lib/config.ts';
      import { GwClient } from './src/lib/client.ts';
      const cfg = loadConfig();
      const client = new GwClient(cfg.host, cfg.key, () => cfg.gatewayProxy);
      // Persist the proof independently of child stdout flushing at exit.
      const { writeFileSync } = await import('node:fs');
      writeFileSync(${JSON.stringify(join(dir, 'result.txt'))}, (await client.keyInfo()).id);
    `], { cwd: join(import.meta.dir, '../..'), env: { ...env, XDG_CONFIG_HOME: dir }, stdout: 'pipe', stderr: 'pipe' })
    const [, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(error).toBe('')
    expect(status).toBe(0)
    expect(readFileSync(join(dir, 'result.txt'), 'utf8')).toBe('persisted-proxy')
    expect(requests).toEqual(['http://gateway.invalid/v1/key'])
  } finally {
    proxy.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
}, 10000)
