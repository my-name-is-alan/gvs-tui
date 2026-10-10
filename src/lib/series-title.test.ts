import { expect, test } from 'bun:test'
import { parseSeriesTitle, seriesSeason, tmdbSeasonOverride, tmdbTitleQueries } from './series-title.ts'

test('separates Chinese, full-width and English season suffixes from the series name', () => {
  for (const title of ['大王饶命 第2季', '大王饶命第二季', '大王饶命（第２季）', '大王饶命 Season 2', '大王饶命 S02', '大王饶命 [Season 2]']) {
    expect(parseSeriesTitle(title)).toEqual({ title: '大王饶命', season: 2 })
  }
  expect(parseSeriesTitle('某剧 第十二季')).toEqual({ title: '某剧', season: 12 })
  expect(parseSeriesTitle('某剧 第二十季')).toEqual({ title: '某剧', season: 20 })
})

test('does not strip sequel/episode numbers or season words inside titles', () => {
  for (const title of ['庆余年2', '无间道第二部', '大王饶命第三集', '四季情', '第2季', '大王饶命 第0季', '大王饶命 第2季预告', 'ClassS02']) {
    expect(parseSeriesTitle(title)).toEqual({ title })
  }
})

test('explicit episode seasons take precedence over inferred seasons and S01 fallback', () => {
  expect(seriesSeason(0, '某综艺 第7季')).toBe(0)
  expect(seriesSeason(undefined, '大王饶命 第2季')).toBe(2)
  expect(seriesSeason(3, '大王饶命 第2季')).toBe(3)
  expect(seriesSeason(undefined, '大王饶命')).toBe(1)
})

test('final-season labels provide a search fallback without guessing a season or stripping real titles', () => {
  for (const title of ['诛仙 最终季', '诛仙（最终季）', '诛仙 完结季', '诛仙 Final Season'])
    expect(tmdbTitleQueries(title)).toEqual([title, '诛仙'])
  expect(tmdbTitleQueries('大王饶命 第2季')).toEqual(['大王饶命'])
  for (const title of ['最终季', '最后一季', '最终季的故事', '四季情', '庆余年2', '最终季预告'])
    expect(tmdbTitleQueries(title)).toEqual([title])
  expect(parseSeriesTitle('诛仙 最终季')).toEqual({ title: '诛仙 最终季' })
  expect(seriesSeason(undefined, '诛仙 最终季')).toBe(1)
})

test('annual animation labels provide a base-title search without guessing seasons or changing platform titles', () => {
  for (const title of ['逆天邪神年番', '逆天邪神 年番', '逆天邪神（年番）', '逆天邪神【年番】', '逆天邪神 · 年番']) {
    expect(tmdbTitleQueries(title)).toEqual([title, '逆天邪神'])
    expect(parseSeriesTitle(title)).toEqual({ title })
    expect(seriesSeason(undefined, title)).toBe(1)
    expect(seriesSeason(2, title)).toBe(2)
  }
  expect(tmdbTitleQueries('逆天邪神年番 第2季')).toEqual(['逆天邪神年番', '逆天邪神'])
  for (const title of ['年番', '年番的故事', '逆天邪神年番预告', '逆天邪神 动态漫画'])
    expect(tmdbTitleQueries(title)).toEqual([title])
})

test('a TMDB-bound output season accepts special season zero, rejects invalid or unbound overrides', () => {
  const match = { id: 206484, kind: 'show' as const }
  expect(tmdbSeasonOverride(undefined, null)).toBeUndefined()
  expect(tmdbSeasonOverride(4, match)).toBe(4)
  expect(tmdbSeasonOverride(0, match)).toBe(0)
  for (const season of [-1, 1.5, NaN, Infinity, 1000]) expect(() => tmdbSeasonOverride(season, match)).toThrow('无效')
  for (const hit of [null, { ...match, kind: 'movie' as const }, { ...match, id: 0 }])
    expect(() => tmdbSeasonOverride(4, hit)).toThrow('请先绑定')
})
