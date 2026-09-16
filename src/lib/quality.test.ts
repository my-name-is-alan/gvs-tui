import { describe, expect, test } from 'bun:test'
import { youkuAudiosFromPlay, youkuEditionLabel, youkuEditionsFromDetail } from './quality.ts'
describe('youkuAudiosFromPlay', () => {
  test('第九区: catalog + tracks → 3 codec rows, skip empty 普通话 pointer', () => {
    const rows = youkuAudiosFromPlay({
      audios: [
        { stream_type: 'cmfa4hd5_atmos51', name: 'en', title: 'en', lang: 'en' },
        { stream_type: 'cmfa3hd4_dtsx', name: 'en', title: 'en', lang: 'en' },
        { stream_type: 'cmfa1hd3', name: 'en', title: 'en', lang: 'en' },
      ],
      audio_tracks: [
        { stream_type: 'cmfa4hd5_atmos51', lang: 'en', langcode: 'en', default: false },
        { stream_type: 'cmfa3hd4_dtsx', lang: 'en', langcode: 'en', default: false },
        { stream_type: 'cmfa1hd3', lang: 'en', langcode: 'en', default: true },
        { stream_type: '', lang: '普通话', langcode: 'guoyu', default: false },
      ],
    })
    expect(rows.map((a) => a.label)).toEqual(['AAC', '杜比全景声', 'DTS:X'])
    expect(rows.map((a) => a.lang)).toEqual(['英语', '英语', '英语'])
    expect(rows[0].id).toBe('cmfa1hd3')
    expect(rows[0].isDefault).toBe(true)
    expect(rows[0].selected).toBe(true)
    expect(rows.every((a) => a.id)).toBe(true)
  })

  test('audios[] only still lists codec tracks', () => {
    const rows = youkuAudiosFromPlay({
      audios: [{ stream_type: 'cmfa3hd4_dtsx', name: 'DOLBY', lang: 'en' }],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].label).toBe('DTS:X')
    expect(rows[0].lang).toBe('英语')
    expect(rows[0].isDefault).toBe(true)
  })
})

describe('youkuEditionsFromDetail', () => {
  test('第九区 dvd.audiolang → 英语版 / 国语版', () => {
    const rows = youkuEditionsFromDetail({
      languages: [
        { lang: '英语', langcode: 'en', vid: 'XEN', main: true },
        { lang: '普通话', langcode: 'guoyu', vid: 'XCN', main: false },
      ],
    })
    expect(rows.map((e) => e.title)).toEqual(['英语版', '国语版'])
    expect(rows.map((e) => e.vid)).toEqual(['XEN', 'XCN'])
    expect(rows.every((e) => e.group === 'edition')).toBe(true)
    expect(rows.every((e) => !e.selected)).toBe(true)
  })

  test('skips duplicate vids', () => {
    const rows = youkuEditionsFromDetail({
      languages: [
        { lang: 'en', langcode: 'en', vid: 'X1' },
        { lang: '英语', langcode: 'en', vid: 'X1' },
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('英语版')
  })
})

test('youkuEditionLabel', () => {
  expect(youkuEditionLabel('普通话', 'guoyu')).toBe('国语版')
  expect(youkuEditionLabel('英语', 'en')).toBe('英语版')
})
