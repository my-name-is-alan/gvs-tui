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

  test('regular show and movie layouts keep their existing naming', () => {
    expect(folder(movie({ kind: 'show' }), 'downloads')).toBe(join('downloads', 'District.9.2009', 'Season 01'))
    expect(folder(movie(), 'downloads')).toBe(join('downloads', 'District.9.2009'))
  })
})
