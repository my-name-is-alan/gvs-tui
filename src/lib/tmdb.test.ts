import { expect, test } from 'bun:test'
import { createTmdbDetails, createTmdbSearch, createTmdbSeasons, normalizeTmdbProxy } from './tmdb'

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

test('an empty final-season search falls back to the base show, but an exact title is kept', async () => {
  const queries: string[] = []
  const search = createTmdbSearch(async url => {
    const query = new URL(url).searchParams.get('query')!
    queries.push(query)
    return Response.json({ results: query === '诛仙' ? [{ id: 206484, media_type: 'tv', name: '诛仙' }] : [] })
  })
  expect((await search('key', 'zh-CN', '诛仙 最终季'))[0]?.id).toBe(206484)
  expect(queries).toEqual(['诛仙 最终季', '诛仙'])
  let calls = 0
  const exact = createTmdbSearch(async () => { calls++; return Response.json({ results: [{ id: 12, media_type: 'tv', name: '某剧 最终季' }] }) })
  expect((await exact('key', 'zh-CN', '某剧 最终季'))[0]?.name).toBe('某剧 最终季')
  expect(calls).toBe(1)
})

test('annual titles fall back to their parent show only after an empty search and retain an exact full-title match', async () => {
  const queries: string[] = []
  const search = createTmdbSearch(async url => {
    const query = new URL(url).searchParams.get('query')!
    queries.push(query)
    return Response.json({ results: query === '逆天邪神' ? [{ id: 235643, media_type: 'tv', name: '逆天邪神', first_air_date: '2023-09-23' }] : [] })
  })
  expect((await search('key', 'zh-CN', '逆天邪神年番'))[0]).toMatchObject({ id: 235643, name: '逆天邪神', year: 2023, kind: 'show' })
  expect(queries).toEqual(['逆天邪神年番', '逆天邪神'])
  let calls = 0
  const exact = createTmdbSearch(async () => { calls++; return Response.json({ results: [{ id: 12, media_type: 'tv', name: '某剧年番' }] }) })
  expect((await exact('key', 'zh-CN', '某剧年番'))[0]?.name).toBe('某剧年番')
  expect(calls).toBe(1)
})

test('TMDB seasons retain S00, validate rows, sort by number and share concurrent requests', async () => {
  let calls = 0
  const seasons = createTmdbSeasons(async (url, init) => {
    calls++
    const u = new URL(url)
    if (u.pathname.endsWith('/episode_groups')) return Response.json({ id: 206484, results: [] })
    expect(u.pathname).toBe('/3/tv/206484')
    expect(u.searchParams.get('language')).toBe('zh-CN')
    expect(init?.proxy).toBe('http://127.0.0.1:7897')
    return Response.json({ id: 206484, seasons: [
      { season_number: 4, name: '第 4 季', episode_count: 26, air_date: '2026-08-21' },
      { season_number: 0, name: '特别篇', episode_count: 2, air_date: null },
      { season_number: 1, episode_count: 26, air_date: 'bad' },
      { season_number: 4, name: 'duplicate' }, { season_number: -1 }, { season_number: '2' }, { season_number: 2.5 }, null,
    ] })
  })
  const opts = { proxy: 'http://127.0.0.1:7897' }
  const [a, b] = await Promise.all([seasons('key', 'zh-CN', 206484, opts), seasons('key', 'zh-CN', 206484, opts)])
  expect(a).toEqual({ seasons: [
    { number: 0, name: '特别篇', episodeCount: 2, airDate: '' },
    { number: 1, name: '第 1 季', episodeCount: 26, airDate: '' },
    { number: 4, name: '第 4 季', episodeCount: 26, airDate: '2026-08-21' },
  ], warning: '' })
  expect(a).toEqual(b)
  await seasons('key', 'zh-CN', 206484, opts)
  expect(calls).toBe(2)
})

test('season cache is scoped to show, language and proxy; failed responses can be retried', async () => {
  const calls: string[] = []
  const seasons = createTmdbSeasons(async (url, init) => {
    const u = new URL(url)
    if (u.pathname.endsWith('/episode_groups')) return Response.json({ id: Number(u.pathname.split('/').at(-2)), results: [] })
    calls.push(`${u.pathname}:${u.searchParams.get('language')}:${init?.proxy || ''}`)
    if (calls.length <= 2) throw new Error(`private ${url}`)
    return Response.json({ id: Number(u.pathname.split('/').at(-1)), seasons: [] })
  })
  await expect(seasons('private-key', 'zh-CN', 12)).rejects.toThrow('两个 API 地址')
  expect(await seasons('private-key', 'zh-CN', 12)).toEqual({ seasons: [], warning: '' })
  await seasons('private-key', 'en-US', 12)
  await seasons('private-key', 'zh-CN', 13)
  await seasons('private-key', 'zh-CN', 12, { proxy: 'http://127.0.0.1:7897' })
  expect(calls).toHaveLength(6)
  await expect(seasons('key', '', 0)).rejects.toThrow('无效的 TMDB ID')
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

test('each search bypasses cached responses, retaining exact new entries without a release date', async () => {
  let calls = 0
  const search = createTmdbSearch(async (url, init) => {
    expect(init?.cache).toBe('no-store')
    calls++
    if (new URL(url).pathname.endsWith('/search/movie')) return Response.json({ results: [] })
    return Response.json({ results: calls === 1 ? [] : [{ id: 1793262, media_type: 'movie', title: '捉妖天师', release_date: '' }] })
  })
  expect(await search('key', 'zh-CN', '捉妖天师')).toEqual([])
  expect((await search('key', 'zh-CN', '捉妖天师'))[0]).toMatchObject({ id: 1793262, name: '捉妖天师', year: 0, kind: 'movie' })
  expect(calls).toBe(3)
})

test('regional movie search fills missing years by ID without changing known years, TV hits or result order', async () => {
  const calls: string[] = []
  const search = createTmdbSearch(async (url, init) => {
    const u = new URL(url)
    calls.push(u.pathname)
    expect(init?.cache).toBe('no-store')
    expect(init?.proxy).toBe('http://127.0.0.1:7897')
    if (u.pathname.endsWith('/search/multi')) return Response.json({ results: [
      { id: 3053, media_type: 'movie', title: '天师捉妖', release_date: '1967-11-13' },
      { id: 1793262, media_type: 'movie', title: '捉妖天师', release_date: '' },
      { id: 1793262, media_type: 'tv', name: '同名剧集', first_air_date: '' },
    ] })
    expect(u.searchParams.get('query')).toBe('捉妖天师')
    expect(u.searchParams.get('language')).toBe('zh-CN')
    expect(u.searchParams.get('region')).toBe('CN')
    return Response.json({ results: [
      { id: 1793262, title: '捉妖天师', release_date: '2026-10-10' },
      { id: 3053, title: '天师捉妖', release_date: '2026-01-01' },
      { id: 999, title: '捉妖天师', release_date: '2025-01-01' },
    ] })
  })
  const hits = await search('key', 'zh-CN', '捉妖天师', { proxy: 'http://127.0.0.1:7897' })
  expect(hits.map(h => [h.id, h.kind, h.year])).toEqual([
    [3053, 'movie', 1967], [1793262, 'movie', 2026], [1793262, 'show', 0],
  ])
  expect(calls).toEqual(['/3/search/multi', '/3/search/movie'])
})

test('missing movie dates stay unknown when another title ID or an invalid date is returned', async () => {
  const search = createTmdbSearch(async url => Response.json({ results: new URL(url).pathname.endsWith('/search/multi')
    ? [{ id: 1793262, media_type: 'movie', title: '捉妖天师', release_date: '' }]
    : [{ id: 999, title: '捉妖天师', release_date: '2026-10-10' }, { id: 1793262, release_date: '2026?' }] }))
  expect((await search('key', '', '捉妖天师'))[0]?.year).toBe(0)
})

test('unavailable optional movie search preserves the original candidates', async () => {
  let calls = 0
  const search = createTmdbSearch(async url => {
    calls++
    if (new URL(url).pathname.endsWith('/search/movie')) return new Response('unavailable', { status: 503 })
    return Response.json({ results: [{ id: 1793262, media_type: 'movie', title: '捉妖天师', release_date: '' }] })
  })
  expect((await search('key', '', '捉妖天师'))[0]).toMatchObject({ id: 1793262, name: '捉妖天师', year: 0 })
  expect(calls).toBe(3)
})

test('complete movie dates and TV searches do not trigger the optional movie request', async () => {
  let calls = 0
  const search = createTmdbSearch(async url => {
    calls++
    expect(new URL(url).pathname).toBe('/3/search/multi')
    return Response.json({ results: [
      { id: 1, media_type: 'movie', title: '电影', release_date: '2026-10-10' },
      { id: 2, media_type: 'tv', name: '剧集', first_air_date: '' },
    ] })
  })
  await search('key', '', '电影')
  expect(calls).toBe(1)
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

test('movie origin country fills a missing production country list and never replaces a populated one', async () => {
  const details = createTmdbDetails(async url => {
    const id = Number(new URL(url).pathname.split('/').at(-1))
    return Response.json({ id, original_language: 'zh', origin_country: ['CN'],
      production_countries: id === 1793262 ? [] : [{ iso_3166_1: 'US' }] })
  })
  expect(await details('key', 'movie', 1793262)).toEqual({ id: 1793262, kind: 'movie', countries: ['CN'], originalLanguage: 'zh' })
  expect((await details('key', 'movie', 123)).countries).toEqual(['US'])
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

test('episode groups add named season choices without replacing ordinary seasons or shifting their order', async () => {
  const id = '67680070aff5a7d64174fbab'
  const calls: string[] = []
  const seasons = createTmdbSeasons(async (url, init) => {
    const u = new URL(url)
    calls.push(u.pathname)
    expect(init?.proxy).toBe('http://127.0.0.1:7897')
    expect(u.searchParams.get('language')).toBe('zh-CN')
    if (u.pathname === '/3/tv/75787') return Response.json({ id: 75787, seasons: [{ season_number: 1, name: '第 1 季', episode_count: 183, air_date: '2015-06-25' }] })
    if (u.pathname.endsWith('/episode_groups')) return Response.json({ id: 75787, results: [
      { id, name: 'Seasons', type: 6 }, { id, name: 'duplicate' }, { id: '../private', name: 'invalid' }, null,
    ] })
    expect(u.pathname).toBe('/3/tv/episode_group/' + id)
    return Response.json({ id, groups: [
      { order: 13, name: '黄风岭篇', episodes: [{ id: 1, episode_number: 168, air_date: '2026-09-18' }, { id: 2, episode_number: 169, air_date: '2026-09-11' }, null] },
      { order: 1, name: '下沙篇', episodes: [{ id: 3, air_date: '2015-06-25' }] },
      { order: 0, name: '特别篇', episodes: [] }, { order: 0, name: 'duplicate', episodes: [] },
      { order: -1, episodes: [] }, { order: '2', episodes: [] }, { order: 2.5, episodes: [] }, { order: 1000, episodes: [] }, { order: 3 }, null,
    ] })
  })
  const result = await seasons('key', '', 75787, { proxy: 'http://127.0.0.1:7897' })
  expect(result).toEqual({ seasons: [
    { number: 1, name: '第 1 季', episodeCount: 183, airDate: '2015-06-25' },
    { number: 0, name: '特别篇', episodeCount: 0, airDate: '', groupId: id, groupName: 'Seasons' },
    { number: 1, name: '下沙篇', episodeCount: 1, airDate: '2015-06-25', groupId: id, groupName: 'Seasons' },
    { number: 13, name: '黄风岭篇', episodeCount: 2, airDate: '2026-09-11', groupId: id, groupName: 'Seasons' },
  ], warning: '' })
  expect(calls).toHaveLength(3)
  expect(JSON.stringify(result)).not.toContain('episode_number')
})

test('an unavailable group list preserves ordinary seasons, warns safely and permits an immediate retry', async () => {
  let failed = true, listCalls = 0
  const seasons = createTmdbSeasons(async url => {
    const u = new URL(url)
    if (!u.pathname.endsWith('/episode_groups')) return Response.json({ id: 123, seasons: [{ season_number: 0 }] })
    listCalls++
    if (failed) throw new Error('private key in URL: ' + url)
    return Response.json({ id: 123, results: [] })
  })
  const result = await seasons('private-key', '', 123)
  expect(result.seasons).toEqual([{ number: 0, name: '特别篇', episodeCount: 0, airDate: '' }])
  expect(result.warning).toContain('剧集分组读取失败')
  expect(result.warning).not.toContain('private-key')
  failed = false
  expect((await seasons('private-key', '', 123)).warning).toBe('')
  expect(listCalls).toBe(3)
})

test('partial group failures retain other groups, use at most three parallel reads and retain source order', async () => {
  const groups = Array.from({ length: 5 }, (_, i) => ({ id: String(i + 1).padStart(24, '0'), name: '分组 ' + i }))
  let active = 0, maximum = 0, fail = true
  const seasons = createTmdbSeasons(async url => {
    const u = new URL(url)
    if (u.pathname === '/3/tv/321') return Response.json({ id: 321, seasons: [{ season_number: 1 }] })
    if (u.pathname.endsWith('/episode_groups')) return Response.json({ id: 321, results: groups })
    active++; maximum = Math.max(maximum, active)
    try {
      await Bun.sleep(5)
      const id = u.pathname.split('/').at(-1)!
      if (id === groups[1]!.id && fail) return new Response('', { status: 404 })
      return Response.json({ id, groups: [{ order: 1, name: '第一季', episodes: [] }] })
    } finally { active-- }
  })
  const first = await seasons('key', '', 321)
  expect(maximum).toBeLessThanOrEqual(3)
  expect(first.seasons.map(row => row.groupId).filter(Boolean)).toEqual([groups[0]!.id, ...groups.slice(2).map(g => g.id)])
  expect(first.warning).toContain('部分剧集分组')
  fail = false
  const retry = await seasons('key', '', 321)
  expect(retry.seasons).toHaveLength(6)
  expect(retry.warning).toBe('')
})

test('wrong group response identity cannot supply output season choices', async () => {
  const id = '67680070aff5a7d64174fbab'
  const seasons = createTmdbSeasons(async url => {
    const path = new URL(url).pathname
    if (path === '/3/tv/75787') return Response.json({ id: 75787, seasons: [] })
    if (path.endsWith('/episode_groups')) return Response.json({ id: 75787, results: [{ id, name: 'Seasons' }] })
    return Response.json({ id: 'different-group', groups: [{ order: 13, name: 'wrong title', episodes: [] }] })
  })
  const result = await seasons('key', '', 75787)
  expect(result.seasons).toEqual([])
  expect(result.warning).toContain('部分剧集分组')
})
