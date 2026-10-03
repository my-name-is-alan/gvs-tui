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

test('an exact movie match survives an unknown/default-TV platform type', () => {
  expect(defaultTmdbHit([movie], '爸爸是外星人', 0, 'show')).toEqual(movie)
  expect(defaultTmdbHit([movie], '爸爸是外星人', 2024, 'show')?.kind).toBe('movie')
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
