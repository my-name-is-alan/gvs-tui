import type { TmdbHit } from './api'
import { tmdbTitleQueries } from '../../../src/lib/series-title'

const titleKey = (title: string) => title.normalize('NFKC').replace(/[\s·・]/g, '').toLowerCase()

/** Correct a missing/wrong platform type only with an unambiguous title/year match. */
export function defaultTmdbHit(hits: TmdbHit[], title: string, year: number, kind: TmdbHit['kind']): TmdbHit | null {
  const series = tmdbTitleQueries(title).at(-1)!
  // A later season's year differs from the series premiere. Require the exact
  // base title and TV type, and still leave equal-title remakes unselected.
  const exact = hits.filter(h => {
    const key = titleKey(h.name || h.title)
    // A newly added entry may not have its release date yet. Missing metadata
    // does not contradict an exact title; a known different year still does.
    return (key === titleKey(title) && (!year || !h.year || h.year === year))
      || (series !== title.trim() && h.kind === 'show' && key === titleKey(series))
  })
  const sameKind = exact.filter(h => h.kind === kind)
  if (sameKind.length === 1) return sameKind[0]!
  if (exact.length === 1) return exact[0]!
  // Keep ambiguous matches visible for the user rather than picking a remake.
  if (exact.length > 1) return null
  return hits.find(h => h.kind === kind) ?? null
}
