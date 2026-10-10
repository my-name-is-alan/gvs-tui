import { expect, test } from 'bun:test'
import { defaultTmdbHit } from './tmdb-selection'
import type { TmdbHit } from './api'

const movie: TmdbHit = { id: 1296715, name: '爸爸是外星人', title: '爸爸是外星人', year: 2024, overview: '', kind: 'movie' }

test('a later season matches the series premiere, even when the platform reports a later year', () => {
  const show: TmdbHit = { id: 146339, name: '大王饶命', title: '', year: 2021, overview: '', kind: 'show' }
  expect(defaultTmdbHit([show], '大王饶命 第2季', 2023, 'show')).toEqual(show)
  expect(defaultTmdbHit([show], '大王饶命 第一季', 2021, 'show')).toEqual(show)
  expect(defaultTmdbHit([show], '大王饶命 第2季', 2023, 'movie')).toEqual(show)
  expect(defaultTmdbHit([show, { ...show, id: 2, year: 2023 }], '大王饶命 第2季', 2023, 'show')).toBe(null)
  expect(defaultTmdbHit([{ ...show, kind: 'movie' }], '大王饶命 第2季', 2023, 'show')).toBe(null)
})

test('a final season matches the base series despite its later release year, with ambiguous remakes left unselected', () => {
  const show: TmdbHit = { id: 206484, name: '诛仙', title: '', year: 2022, overview: '', kind: 'show' }
  expect(defaultTmdbHit([show], '诛仙 最终季', 2026, 'show')).toEqual(show)
  expect(defaultTmdbHit([show, { ...show, id: 2, year: 2026 }], '诛仙 最终季', 2026, 'show')).toBe(null)
})

test('annual animation matches the base TV title despite a later year and avoids remake ambiguity', () => {
  const show: TmdbHit = { id: 235643, name: '逆天邪神', title: '', year: 2023, overview: '', kind: 'show' }
  const comic = { ...show, id: 250894, name: '逆天邪神 动态漫画', year: 2021 }
  for (const title of ['逆天邪神年番', '逆天邪神 年番']) {
    expect(defaultTmdbHit([comic, show], title, 2026, 'show')).toEqual(show)
    expect(defaultTmdbHit([show, { ...show, id: 2, year: 2026 }], title, 2026, 'show')).toBe(null)
  }
})

test('an exact movie match survives an unknown/default-TV platform type', () => {
  expect(defaultTmdbHit([movie], '爸爸是外星人', 0, 'show')).toEqual(movie)
  expect(defaultTmdbHit([movie], '爸爸是外星人', 2024, 'show')?.kind).toBe('movie')
})

test('an exact newly added movie without a date beats unrelated older search results', () => {
  const older: TmdbHit = { id: 3053, name: '天师捉妖', title: '天师捉妖', year: 1967, overview: '', kind: 'movie' }
  const current: TmdbHit = { id: 1793262, name: '捉妖天师', title: '捉妖天师', year: 0, overview: '', kind: 'movie' }
  const tv: TmdbHit = { ...older, id: 235078, name: '天师斗妖姬', kind: 'show' }
  expect(defaultTmdbHit([older, current, tv], '捉妖天师', 2026, 'movie')).toEqual(current)
  expect(defaultTmdbHit([older, current, tv], '捉妖天师', 2026, 'show')).toEqual(current)
  expect(defaultTmdbHit([current, { ...current, id: 2 }], '捉妖天师', 2026, 'movie')).toBe(null)
  expect(defaultTmdbHit([{ ...current, year: 2025 }], '捉妖天师', 2026, 'show')).toBe(null)
})

test('an exact TV match similarly corrects a default movie type', () => {
  const show = { ...movie, name: '某剧集', kind: 'show' as const }
  expect(defaultTmdbHit([show], '某剧集', 2024, 'movie')).toEqual(show)
})

test('unrelated movies and wrong-year matches cannot override the platform type', () => {
  expect(defaultTmdbHit([movie], '其他节目', 0, 'show')).toBe(null)
  expect(defaultTmdbHit([movie], '爸爸是外星人', 2025, 'show')).toBe(null)
  const show = { ...movie, name: '其他剧集', kind: 'show' as const }
  expect(defaultTmdbHit([movie, show], '其他剧集', 0, 'show')).toEqual(show)
})

test('year and type disambiguate remakes and equal movie/TV numeric IDs', () => {
  const remake = { ...movie, id: 456, year: 2025 }
  expect(defaultTmdbHit([movie, remake], movie.name, 0, 'movie')).toBe(null)
  expect(defaultTmdbHit([movie, remake], movie.name, 2025, 'movie')).toEqual(remake)
  const show = { ...movie, kind: 'show' as const }
  expect(defaultTmdbHit([movie, show], movie.name, 2024, 'show')).toEqual(show)
})
