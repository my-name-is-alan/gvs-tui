import { describe, expect, test } from 'bun:test'
import { moviePlayables, probeOptions, youkuAudiosFromPlay, youkuEditionLabel, youkuEditionsFromDetail, youkuMergeEditionAudios } from './quality.ts'
import type { FileConfig } from './config.ts'
import type { GwClient } from './client.ts'
describe('youkuAudiosFromPlay', () => {
  test('format priority, platform default within a format, stable ties and all selected', () => {
    const rows = youkuAudiosFromPlay({ audio_tracks: [
      { stream_type: 'other' },
      { stream_type: 'aac_first' },
      { stream_type: 'aac_default', default: true },
      { stream_type: 'dtsx' },
      { stream_type: 'atmos' },
      { stream_type: 'aac_last' },
    ] })
    expect(rows.map(a => a.id)).toEqual(['atmos', 'dtsx', 'aac_default', 'aac_first', 'aac_last', 'other'])
    expect(rows.every(a => a.selected)).toBe(true)
    expect(rows.filter(a => a.isDefault).map(a => a.id)).toEqual(['aac_default'])
    expect(youkuAudiosFromPlay({})).toEqual([])
  })
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
    expect(rows.map((a) => a.label)).toEqual(['杜比全景声', 'DTS:X', 'AAC'])
    expect(rows.map((a) => a.lang)).toEqual(['英语', '英语', '英语'])
    expect(rows[0].id).toBe('cmfa4hd5_atmos51')
    expect(rows[2].isDefault).toBe(true)
    expect(rows.every(a => a.selected)).toBe(true)
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

test('youkuMergeEditionAudios keeps 英语 and 普通话 cmfa1hd3 as separate rows', () => {
  const rows = youkuMergeEditionAudios(
    'XEN',
    { audio_tracks: [{ stream_type: 'cmfa1hd3', lang: 'en', langcode: 'en', default: true }] },
    [{ vid: 'XCN', data: { audio_tracks: [{ stream_type: 'cmfa1hd3', lang: '普通话', langcode: 'guoyu' }] } }],
  )
  expect(rows.map((a) => a.id)).toEqual(['XEN|cmfa1hd3', 'XCN|cmfa1hd3'])
  expect(rows.map((a) => a.lang)).toEqual(['英语', '普通话'])
  expect(rows[0]!.isDefault).toBe(true)
  expect(rows[1]!.isDefault).toBe(false)
  expect(rows[1]!.vid).toBe('XCN')
})

test('probeYouku also plays the sibling language vid for audio', async () => {
  const vids: string[] = []
  const cli = {
    extra: () => ({}),
    invoke: async (_p: string, _a: string, input: { vid: string }) => {
      vids.push(input.vid)
      if (input.vid === 'XEN') {
        return {
          streams: [{ stream_type: 'hd4', media_type: 'video', playlist_url: 'https://v', width: 3840, height: 1608 }],
          audio_tracks: [{ stream_type: 'cmfa1hd3', lang: 'en', langcode: 'en', default: true }],
          languages: [
            { lang: '英语', langcode: 'en', vid: 'XEN', main: true },
            { lang: '普通话', langcode: 'guoyu', vid: 'XCN' },
          ],
        }
      }
      return { audio_tracks: [{ stream_type: 'cmfa1hd3', lang: '普通话', langcode: 'guoyu' }] }
    },
  } as unknown as GwClient
  const opts = await probeOptions(cli, {} as FileConfig, 'youku', 'XEN')
  expect(vids).toEqual(['XEN', 'XCN'])
  expect(opts.audios.map((a) => a.lang)).toEqual(['英语', '普通话'])
  expect(opts.audios.map((a) => a.id)).toEqual(['XEN|cmfa1hd3', 'XCN|cmfa1hd3'])
})

test('probeYouku uses episode languageVids when play omits languages', async () => {
  const vids: string[] = []
  const cli = {
    extra: () => ({}),
    invoke: async (_p: string, _a: string, input: { vid: string }) => {
      vids.push(input.vid)
      if (input.vid === 'XEN') {
        return {
          streams: [{ stream_type: 'hd4', media_type: 'video', playlist_url: 'https://v', width: 3840, height: 1608 }],
          audio_tracks: [
            { stream_type: 'cmfa4hd5_atmos51', lang: 'en', langcode: 'en' },
            { stream_type: 'cmfa3hd4_dtsx', lang: 'en', langcode: 'en' },
            { stream_type: 'cmfa1hd3', lang: 'en', langcode: 'en', default: true },
          ],
        }
      }
      return { audio_tracks: [{ stream_type: 'cmfa1hd3', lang: '普通话', langcode: 'guoyu' }] }
    },
  } as unknown as GwClient
  const opts = await probeOptions(cli, {} as FileConfig, 'youku', 'XEN', { languageVids: ['XCN'] })
  expect(vids).toEqual(['XEN', 'XCN'])
  expect(opts.audios.map((a) => a.lang)).toEqual(['英语', '英语', '英语', '普通话'])
})

describe('moviePlayables', () => {
  test('第九区 detail has no episodes: title vid is 正片', () => {
    const rows = moviePlayables({
      title: '第九区',
      category: '电影',
      vid: 'XMTQwNzMzMDIwNA==',
      episodes: [],
      duration: 6671,
    })
    expect(rows).toEqual([
      {
        title: '正片',
        vid: 'XMTQwNzMzMDIwNA==',
        number: 1,
        selected: false,
        duration: 6671,
        group: 'edition',
      },
    ])
  })

  test('play languages collapse to one 正片 using the main vid', () => {
    const rows = moviePlayables(
      { vid: 'XEN', episodes: [] },
      {
        languages: [
          { lang: '英语', langcode: 'en', vid: 'XEN', main: true },
          { lang: '普通话', langcode: 'guoyu', vid: 'XCN' },
        ],
      },
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      title: '正片',
      vid: 'XEN',
      group: 'edition',
      languages: [
        { vid: 'XEN', lang: '英语', langcode: 'en' },
        { vid: 'XCN', lang: '普通话', langcode: 'guoyu' },
      ],
    })
  })

  test('failed play still keeps title vid', () => {
    expect(moviePlayables({ vid: 'X1' })).toEqual([
      expect.objectContaining({ title: '正片', vid: 'X1', group: 'edition' }),
    ])
  })

  test('no vid and no languages → empty, not a fake episode', () => {
    expect(moviePlayables({ title: '第九区', episodes: [] })).toEqual([])
  })
})
