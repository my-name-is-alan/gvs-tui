import type { Episode } from '../types.ts'
import { anyInt, firstStr, isObj } from './util.ts'
import { parseSeriesTitle } from './series-title.ts'

/** One parser for the terminal and desktop clients. Official collections must
 * survive even when their titles contain 彩蛋/采访/预告. */
export function parseEpisodes(data: Record<string, unknown>): Episode[] {
  const official = Array.isArray(data.episode_groups)
  const sources = [data, data.meta, data.raw, data.show].filter(isObj)
  const seasonOf = (row: Record<string, unknown>) => anyInt(row.seasonNumber) || anyInt(row.season_number) || anyInt(row.season) || undefined
  const season = sources.map(seasonOf).find(n => n && n > 0)
    ?? sources.map(row => parseSeriesTitle(firstStr(row, 'title', 'name')).season).find(Boolean)
  const eps: Episode[] = []
  const seen = new Set<string>()
  for (const [i, row] of (Array.isArray(data.episodes) ? data.episodes : []).entries()) {
    if (!isObj(row)) continue
    const it = { ...(isObj(row.meta) ? row.meta : {}), ...row }
    const vid = firstStr(it, 'vid', 'id')
    if (!vid || seen.has(vid)) continue
    const title = firstStr(it, 'title', 'name')
    const group = firstStr(it, 'group', 'kind')
    const duration = anyInt(it.duration) || anyInt(it.duration_ms ? Number(it.duration_ms) / 1000 : 0)
    const extra = /周边|花絮|彩蛋|预告|预约|trailer|advert|extra|clip/i.test(`${group} ${title}`) || it.is_trailer === true
    if (!official && extra && duration < 600) continue
    const n = anyInt(it.ep) || anyInt(it.number) || anyInt(it.episodeNumber) || Number.parseInt(String(it.stage ?? ''), 10)
    eps.push({ vid, title, number: n > 0 ? n : i + 1, selected: false,
      duration: duration || undefined, group, season: seasonOf(it) || season,
      collection: official ? group || '正片' : undefined })
    seen.add(vid)
  }
  return eps
}

export function episodeCollections(eps: ReadonlyArray<{ collection?: string }>): string[] {
  const groups = [...new Set(eps.map(e => e.collection).filter((s): s is string => !!s))]
  return groups.includes('正片') ? ['正片', ...groups.filter(g => g !== '正片')] : groups
}
