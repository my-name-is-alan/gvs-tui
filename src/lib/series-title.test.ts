import { expect, test } from 'bun:test'
import { parseSeriesTitle, seriesSeason } from './series-title.ts'

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
  expect(seriesSeason(undefined, '大王饶命 第2季')).toBe(2)
  expect(seriesSeason(3, '大王饶命 第2季')).toBe(3)
  expect(seriesSeason(undefined, '大王饶命')).toBe(1)
})
