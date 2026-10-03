import { dots } from './name.ts'
import { fetchTmdb, normalizeHttpProxy } from './proxy.ts'
import { runLog } from './runlog.ts'
import { isObj } from './util.ts'
import { parseSeriesTitle } from './series-title.ts'

export type TmdbResult = {
  id: number
  name: string
  title: string
  year: number
  overview: string
  englishDots: string
  kind: 'movie' | 'show'
}

/** Details of the matched title, not the viewer's locale or the release region. */
export type TmdbDetails = {
  id: number
  kind: 'movie' | 'show'
  countries: string[]
  originalLanguage: string
}

type SearchResponse = {
  results?: Array<{
    id: number
    media_type?: string
    name?: string
    title?: string
    original_name?: string
    original_title?: string
    first_air_date?: string
    release_date?: string
    overview?: string
  }>
}

class TmdbHttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403
      ? 'TMDB 凭证无效或没有访问权限，请检查设置中的 TMDB Key'
      : status === 429 ? 'TMDB 请求过于频繁，请稍后重试' : `TMDB HTTP ${status}`)
  }
}

export function normalizeTmdbProxy(value: string): string {
  return normalizeHttpProxy(value)
}

type TmdbRequestInit = RequestInit & { proxy?: string }
type TmdbFetch = (url: string, init?: TmdbRequestInit) => Promise<Response>
type TmdbOptions = { proxy?: string }

/** Both are TMDB API hosts. Keep the last reachable one first for this session. */
function createTmdbRequest(fetcher: TmdbFetch, timeoutMs: number) {
  let preferred = 'api.tmdb.org'
  return async <T>(apiKey: string, path: string, params: Record<string, string>, parse: (out: unknown) => T, options: TmdbOptions): Promise<T> => {
    const key = apiKey.trim().replace(/^Bearer\s+/i, '')
    if (!key) throw new Error('未配置 TMDB API Key')
    const proxy = normalizeTmdbProxy(options.proxy || '')
    const route = proxy ? 'proxy' : 'default'
    const hosts = [preferred, ...['api.tmdb.org', 'api.themoviedb.org'].filter(h => h !== preferred)]
    for (const host of hosts) {
      const url = new URL(`https://${host}/3/${path}`)
      url.search = new URLSearchParams(params).toString()
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (key.includes('.')) headers.Authorization = `Bearer ${key}`
      else url.searchParams.set('api_key', key)
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      const started = Date.now()
      try {
        const res = await fetcher(url.href, { headers, signal: ac.signal, ...(proxy ? { proxy } : {}) })
        if (!res.ok) {
          await res.body?.cancel()
          throw new TmdbHttpError(res.status)
        }
        // The timeout includes reading the body, not just receiving headers.
        const out = parse(await res.json())
        preferred = host
        runLog(`tmdb ${path} host=${host} via=${route} ${Date.now() - started}ms ok`)
        return out
      } catch (e) {
        // Never log the request URL or raw fetch error: either can contain the key.
        const reason = e instanceof TmdbHttpError ? `http=${e.status}` : ac.signal.aborted ? 'timeout' : 'network-or-response'
        runLog(`tmdb ${path} host=${host} via=${route} ${Date.now() - started}ms fail ${reason}`)
        if (e instanceof TmdbHttpError && e.status < 500) throw e
      } finally {
        clearTimeout(timer)
      }
    }
    throw new Error(proxy
      ? '无法通过代理连接 TMDB（两个 API 地址均未成功），请检查代理是否运行及其分流规则'
      : '无法连接 TMDB（两个 API 地址均未成功），可在设置 → TMDB 代理中填写本地代理地址')
  }
}

export function createTmdbSearch(fetcher: TmdbFetch = fetchTmdb, timeoutMs = 10_000) {
  const request = createTmdbRequest(fetcher, timeoutMs)
  return (apiKey: string, lang: string, query: string, options: TmdbOptions = {}): Promise<TmdbResult[]> => {
    if (!query.trim()) return Promise.reject(new Error('缺少用于 TMDB 搜索的片名'))
    // Missing platform categories must not lock a movie into the TV endpoint.
    return request(apiKey, 'search/multi', { language: lang || 'zh-CN', query: parseSeriesTitle(query).title, include_adult: 'false' }, out => {
      if (!isObj(out) || !Array.isArray(out.results)) throw new Error('invalid TMDB response')
      const rows = (out as SearchResponse).results!.filter(h => h.media_type === 'movie' || h.media_type === 'tv').slice(0, 8)
      return rows.map(h => {
        const movie = h.media_type === 'movie'
        const date = (movie ? h.release_date : h.first_air_date) || ''
        const name = (movie ? h.title : h.name) || ''
        return { id: h.id, name, title: h.title || '', year: Number.parseInt(date.slice(0, 4), 10) || 0,
          overview: h.overview || '', englishDots: dots(h.original_name || h.original_title || name), kind: movie ? 'movie' : 'show' }
      })
    }, options)
  }
}

/** Cancellation stops this caller's wait without aborting another episode's shared request. */
function waitForDetails(promise: Promise<TmdbDetails>, signal?: AbortSignal): Promise<TmdbDetails> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

/** One details request per matched title in a batch, including concurrent episodes. */
export function createTmdbDetails(fetcher: TmdbFetch = fetchTmdb, timeoutMs = 10_000) {
  const request = createTmdbRequest(fetcher, timeoutMs)
  const cache = new Map<string, { expires: number; promise: Promise<TmdbDetails> }>()
  return (apiKey: string, kind: 'movie' | 'show', id: number, options: TmdbOptions & { signal?: AbortSignal } = {}): Promise<TmdbDetails> => {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason)
    if (!Number.isSafeInteger(id) || id <= 0) return Promise.reject(new Error('无效的 TMDB ID'))
    const key = JSON.stringify([apiKey.trim(), kind, id, options.proxy || ''])
    const hit = cache.get(key)
    if (hit && hit.expires > Date.now()) return waitForDetails(hit.promise, options.signal)
    const promise = request(apiKey, `${kind === 'movie' ? 'movie' : 'tv'}/${id}`, {}, out => {
      if (!isObj(out) || out.id !== id) throw new Error('invalid TMDB details')
      // TV origin_country describes where the show originated; production countries
      // are the fallback for older/incomplete TV records and the movie API.
      const origin = Array.isArray(out.origin_country) ? out.origin_country : []
      const production = Array.isArray(out.production_countries) ? out.production_countries.filter(isObj).map(c => c.iso_3166_1) : []
      const countries = (kind === 'show' && origin.length ? origin : production)
        .filter((c): c is string => typeof c === 'string' && /^[a-z]{2}$/i.test(c)).map(c => c.toUpperCase())
      return { id, kind, countries: [...new Set(countries)], originalLanguage: typeof out.original_language === 'string' ? out.original_language.toLowerCase() : '' }
    }, options).then(value => {
      entry.expires = Date.now() + 60 * 60_000
      return value
    }, error => {
      // Avoid repeated timeouts for every episode; a retry can recover shortly.
      entry.expires = Date.now() + 30_000
      throw error
    })
    const entry = { expires: Infinity, promise }
    cache.delete(key)
    cache.set(key, entry)
    if (cache.size > 128) cache.delete(cache.keys().next().value!)
    return waitForDetails(entry.promise, options.signal)
  }
}

export const tmdbSearch = createTmdbSearch()
export const tmdbDetails = createTmdbDetails()
