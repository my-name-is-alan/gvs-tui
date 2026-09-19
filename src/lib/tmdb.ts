import { dots } from './name.ts'
import { fetchRemote } from './proxy.ts'

export type TmdbResult = {
  id: number
  name: string
  title: string
  year: number
  overview: string
  englishDots: string
}

export async function tmdbSearch(apiKey: string, lang: string, query: string, tv: boolean): Promise<TmdbResult[]> {
  if (!apiKey || !query) throw new Error('未配置 TMDB API Key')
  const kind = tv ? 'tv' : 'movie'
  const u = `https://api.themoviedb.org/3/search/${kind}?api_key=${encodeURIComponent(apiKey)}&language=${encodeURIComponent(lang)}&query=${encodeURIComponent(query)}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 20_000)
  let res: Response
  try {
    res = await fetchRemote(u, { signal: ac.signal })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new Error(`tmdb ${res.status}`)
  const out = await res.json() as {
    results?: Array<{
      id: number
      name?: string
      title?: string
      original_name?: string
      original_title?: string
      first_air_date?: string
      release_date?: string
      overview?: string
    }>
  }
  const rows = (out.results ?? []).slice(0, 8)
  return rows.map((h) => {
    const date = h.first_air_date || h.release_date || ''
    const year = date.length >= 4 ? Number.parseInt(date.slice(0, 4), 10) || 0 : 0
    const name = h.name || h.title || ''
    const english = h.original_name || h.original_title || name
    return {
      id: h.id,
      name,
      title: h.title || '',
      year,
      overview: h.overview || '',
      englishDots: dots(english),
    }
  })
}
