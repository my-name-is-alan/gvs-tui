import { expect, test } from 'bun:test'
import { createTmdbDetails, createTmdbSearch, normalizeTmdbProxy } from './tmdb'

const results = [
  { id: 10, media_type: 'person', name: '演员' },
  { id: 415634, media_type: 'movie', title: '追凶者也', release_date: '2016-09-14' },
  { id: 415634, media_type: 'tv', name: '灵境行者', first_air_date: '2026-08-01' },
]

test('season-specific platform titles search TMDB by the series name', async () => {
  const queries: string[] = []
  const search = createTmdbSearch(async url => {
    queries.push(new URL(url).searchParams.get('query')!)
    return Response.json({ results: [{ id: 146339, media_type: 'tv', name: '大王饶命', first_air_date: '2021-12-03' }] })
  })
  for (const title of ['大王饶命 第1季', '大王饶命 第2季', '大王饶命 第二季', '大王饶命 Season 2']) {
    expect((await search('key', 'zh-CN', title))[0]?.id).toBe(146339)
  }
  expect(queries).toEqual(Array(4).fill('大王饶命'))
})

test('searches movies and TV together, excludes people, and retains their distinct types', async () => {
  const search = createTmdbSearch(async (url, init) => {
    const u = new URL(url)
    expect(u.pathname).toBe('/3/search/multi')
    expect(u.searchParams.get('api_key')).toBe('test-key')
    expect(u.searchParams.get('query')).toBe('追凶者也')
    expect(u.searchParams.get('language')).toBe('zh-CN')
    expect(new Headers(init?.headers).has('Authorization')).toBe(false)
    return Response.json({ results })
  })
  const hits = await search(' test-key ', 'zh-CN', ' 追凶者也 ')
  expect(hits.map(h => [h.kind, h.name, h.year])).toEqual([
    ['movie', '追凶者也', 2016], ['show', '灵境行者', 2026],
  ])
})

test('network failures try the alternate host and remember the working host', async () => {
  const hosts: string[] = []
  const search = createTmdbSearch(async (url) => {
    hosts.push(new URL(url).hostname)
    if (hosts.length === 1) throw new Error('connection failed')
    return Response.json({ results: [] })
  })
  await search('key', '', '电影')
  await search('key', '', '剧集')
  expect(hosts).toEqual(['api.tmdb.org', 'api.themoviedb.org', 'api.themoviedb.org'])
})

test('timeout covers response body and falls back when headers arrive but body stalls', async () => {
  let calls = 0
  const search = createTmdbSearch(async (_url, init) => {
    if (++calls > 1) return Response.json({ results })
    return new Response(new ReadableStream({
      start(controller) {
        init!.signal!.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true })
      },
    }))
  }, 20)
  expect(await search('key', '', '电影')).toHaveLength(2)
  expect(calls).toBe(2)
})

test('invalid credentials fail clearly without retrying or exposing the key', async () => {
  let calls = 0
  const search = createTmdbSearch(async () => { calls++; return new Response('denied', { status: 401 }) })
  await expect(search('private-key', '', '电影')).rejects.toThrow('凭证无效')
  expect(calls).toBe(1)
})

test('both network failures produce a safe actionable error', async () => {
  const search = createTmdbSearch(async (url) => { throw new Error(`failed ${url}`) })
  try {
    await search('private-key', '', '电影')
    throw new Error('should fail')
  } catch (e) {
    expect(String(e)).toContain('两个 API 地址')
    expect(String(e)).not.toContain('private-key')
    expect(String(e)).not.toContain('api_key=')
  }
})

test('read access tokens use the Authorization header, never the query string', async () => {
  const search = createTmdbSearch(async (url, init) => {
    expect(new URL(url).searchParams.has('api_key')).toBe(false)
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer header.payload.signature')
    return Response.json({ results: [] })
  })
  await search(' Bearer header.payload.signature ', '', '电影')
})

test('a TMDB-specific proxy is scoped to each search and remains set for alternate hosts', async () => {
  const routes: Array<string | undefined> = []
  const search = createTmdbSearch(async (_url, init) => {
    routes.push(init?.proxy)
    if (routes.length === 1) throw new Error('first host unavailable')
    return Response.json({ results })
  })
  await search('key', '', '电影', { proxy: ' http://127.0.0.1:7897/ ' })
  await search('key', '', '电影')
  expect(routes).toEqual(['http://127.0.0.1:7897', 'http://127.0.0.1:7897', undefined])
})

test('explicit proxy failures never cause an unproxied attempt or expose credentials', async () => {
  const routes: Array<string | undefined> = []
  const search = createTmdbSearch(async (url, init) => {
    routes.push(init?.proxy)
    throw new Error(`${url} via ${init?.proxy}`)
  })
  const proxy = 'http://user:private-password@localhost:7897'
  let message = ''
  try { await search('private-key', '', '电影', { proxy }) }
  catch (e) { message = String(e) }
  expect(routes).toEqual([proxy, proxy])
  expect(message).toContain('通过代理连接 TMDB')
  expect(message).not.toContain('private-password')
  expect(message).not.toContain('private-key')
})

test('proxy setting accepts HTTP(S) endpoints and rejects PAC URLs or invalid protocols', () => {
  expect(normalizeTmdbProxy('  ')).toBe('')
  expect(normalizeTmdbProxy(' http://127.0.0.1:7897/ ')).toBe('http://127.0.0.1:7897')
  expect(normalizeTmdbProxy('https://proxy.example:8443')).toBe('https://proxy.example:8443')
  for (const value of ['127.0.0.1:7897', 'socks5://127.0.0.1:7897', 'http://localhost:52882/commands/pac']) {
    expect(() => normalizeTmdbProxy(value)).toThrow('HTTP/HTTPS')
  }
})

test('matched movie details use production countries, not the search/display locale', async () => {
  const details = createTmdbDetails(async (url, init) => {
    expect(new URL(url).pathname).toBe('/3/movie/653438')
    expect(init?.proxy).toBe('http://127.0.0.1:7897')
    return Response.json({ id: 653438, original_language: 'zh', production_countries: [{ iso_3166_1: 'CN' }, { iso_3166_1: 'CN' }] })
  })
  expect(await details('key', 'movie', 653438, { proxy: 'http://127.0.0.1:7897' }))
    .toEqual({ id: 653438, kind: 'movie', countries: ['CN'], originalLanguage: 'zh' })
})

test('TV origin country wins over overseas production companies and movie IDs stay distinct', async () => {
  const calls: string[] = []
  const details = createTmdbDetails(async url => {
    calls.push(new URL(url).pathname)
    return Response.json({ id: 123, origin_country: ['CN'], original_language: 'zh', production_countries: [{ iso_3166_1: 'US' }] })
  })
  expect((await details('key', 'show', 123)).countries).toEqual(['CN'])
  expect((await details('key', 'movie', 123)).countries).toEqual(['US'])
  expect(calls).toEqual(['/3/tv/123', '/3/movie/123'])
})

test('concurrent episodes share details, one cancelled wait cannot abort the others', async () => {
  let calls = 0
  let release!: (r: Response) => void
  const details = createTmdbDetails(async () => { calls++; return new Promise(r => { release = r }) })
  const ctrl = new AbortController()
  const paused = details('key', 'show', 123, { signal: ctrl.signal })
  const another = details('key', 'show', 123)
  ctrl.abort(new Error('paused'))
  await expect(paused).rejects.toThrow('paused')
  release(Response.json({ id: 123, origin_country: ['CN'] }))
  expect((await another).countries).toEqual(['CN'])
  expect((await details('key', 'show', 123)).countries).toEqual(['CN'])
  expect(calls).toBe(1)
})

test('bad/failed details cannot mislabel a title and do not retry for every episode', async () => {
  let calls = 0
  const details = createTmdbDetails(async () => { calls++; return Response.json({ id: 999, production_countries: [{ iso_3166_1: 'CN' }] }) })
  await expect(details('private-key', 'movie', 123)).rejects.toThrow('两个 API 地址')
  await expect(details('private-key', 'movie', 123)).rejects.toThrow('两个 API 地址')
  expect(calls).toBe(2)
  expect((await createTmdbDetails(async () => Response.json({ id: 123 }))('key', 'movie', 123)).countries).toEqual([])
})
