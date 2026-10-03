import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { filename, folder, sourceTag, type Naming } from './name.ts'

function movie(partial: Partial<Naming> = {}): Naming {
  return {
    kind: 'movie',
    title: '第九区',
    nameDots: 'District.9',
    year: 2009,
    season: 1,
    episode: 1,
    height: 2160,
    codec: 'H265',
    source: 'YK',
    group: 'GVS',
    tmdbId: 0,
    container: 'mkv',
    ...partial,
  }
}

describe('filename', () => {
  test('movie has no SxxExx even if episode is set', () => {
    const name = filename(movie({ edition: '英语版' }))
    expect(name).toBe('District.9.2009.英语版.2160p.YK.WEB-DL.H265-GVS.mkv')
    expect(name.includes('E01')).toBe(false)
    expect(name.includes('S01')).toBe(false)
  })

  test('show still uses SxxExx', () => {
    expect(filename(movie({ kind: 'show', edition: undefined }))).toContain('S01E01')
  })
})

describe('short-drama folders', () => {
  for (const provider of ['hongguo', 'huangguo']) {
    test(`${provider} groups episodes under the title and an unpadded season directory`, () => {
      const naming = movie({ kind: 'short', source: sourceTag(provider), title: '短剧 标题', season: 1 })
      expect(folder(naming, 'downloads')).toBe(join('downloads', '短剧 标题', 'season 1'))
      expect(folder({ ...naming, season: 0 }, 'downloads')).toBe(join('downloads', '短剧 标题', 'season 1'))
      expect(folder({ ...naming, kind: 'show', season: 2 }, 'downloads')).toBe(join('downloads', '短剧 标题', 'season 2'))
    })
  }

  test('regular show and movie folders use the display title and parenthesized year', () => {
    expect(folder(movie({ kind: 'show' }), 'downloads')).toBe(join('downloads', '第九区 (2009)', 'Season 01'))
    expect(folder(movie(), 'downloads')).toBe(join('downloads', '第九区 (2009)'))
  })
})

test('TMDB folders retain the readable title, year and ID above the correct season', () => {
  const naming = movie({ kind: 'show', title: '妾本草芥', nameDots: '妾本草芥', year: 2026, tmdbId: 335218 })
  expect(folder(naming, '/downloads')).toBe(join('/downloads', '妾本草芥 (2026) {tmdb-335218}', 'Season 01'))
  expect(folder({ ...naming, season: 2 }, '/downloads')).toBe(join('/downloads', '妾本草芥 (2026) {tmdb-335218}', 'Season 02'))
  expect(folder({ ...naming, kind: 'movie' }, '/downloads')).toBe(join('/downloads', '妾本草芥 (2026) {tmdb-335218}'))
  expect(folder({ ...naming, title: 'Some Show: A/B', nameDots: 'Some.Show.A.B' }, '/downloads'))
    .toBe(join('/downloads', 'Some Show_ A_B (2026) {tmdb-335218}', 'Season 01'))
  expect(folder({ ...naming, year: 0, tmdbId: 0 }, '/downloads')).toBe(join('/downloads', '妾本草芥', 'Season 01'))
})

test('episode title follows SxxExx and preserves the technical filename suffix', () => {
  const naming = movie({ kind: 'show', title: '现在就出发 第3季', nameDots: '', season: 3, year: 2026,
    episodeTitle: '名场面特辑：目击狼人杀黄Sir出警，狼人有救了！', source: 'TX' })
  expect(filename(naming)).toBe('现在就出发.第3季.S03E01.名场面特辑.目击狼人杀黄Sir出警.狼人有救了.2026.2160p.TX.WEB-DL.H265-GVS.mkv')
  expect(folder(naming, '/downloads')).toBe(folder({ ...naming, episodeTitle: undefined }, '/downloads'))
})

test('empty, punctuation-only and duplicate programme titles do not add a filename component', () => {
  const naming = movie({ kind: 'show' })
  for (const episodeTitle of ['', '  ', ': / ?! ', '第九区', 'District 9', 'district.9']) {
    expect(filename({ ...naming, episodeTitle })).toBe(filename(naming))
  }
})

test('episode title normalizes path separators and control characters without creating directories', () => {
  const name = filename(movie({ kind: 'show', episodeTitle: '上集/下集\\特辑:*?"<>|\n终章\0' }))
  expect(name).toContain('.S01E01.上集.下集.特辑.终章.2009.')
  expect(name).not.toMatch(/[\\/:*?"<>|\x00-\x1f]/)
})

test('long Chinese episode titles fit with sidecars and retain episode and codec information', () => {
  const naming = movie({ kind: 'show', title: '现在就出发 第3季', nameDots: '', episodeTitle: '名场面特辑与本集精彩内容'.repeat(100) })
  const name = filename(naming)
  expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(240)
  expect(Buffer.byteLength(name + '.timing.json', 'utf8')).toBeLessThanOrEqual(255)
  expect(name).toContain('.S01E01.名场面特辑')
  expect(name).toEndWith('.2009.2160p.YK.WEB-DL.H265-GVS.mkv')
  expect(name).not.toContain('�')
  expect(filename({ ...naming, episode: 2 })).not.toBe(name)
})

test('movies and unnumbered short videos keep their existing names', () => {
  expect(filename(movie({ episodeTitle: '不应出现在电影文件名中的集标题' }))).toBe(filename(movie()))
  const naming = movie({ kind: 'short', season: 0, episode: 0 })
  expect(filename({ ...naming, episodeTitle: '单条视频简介' })).toBe(filename(naming))
  expect(filename({ ...naming, season: 1, episode: 2, episodeTitle: '雨夜重逢' })).toContain('.S01E02.雨夜重逢.')
})
