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

  test('does not promote plain Dolby 5.1 to Atmos', () => {
    const rows = youkuAudiosFromPlay({ audio_tracks: [
      { stream_type: 'cmfa4hd4_51' },
      { stream_type: 'cmfa4hd5_atmos51' },
      { stream_type: 'cmfa3hd5' },
      { stream_type: 'cmfa3hd5_dtsx51' },
    ] })
    expect(Object.fromEntries(rows.map((a) => [a.id, a.label]))).toEqual({
      cmfa4hd5_atmos51: '杜比全景声',
      cmfa4hd4_51: '杜比 5.1',
      cmfa3hd5_dtsx51: 'DTS:X',
      cmfa3hd5: 'DTS',
    })
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

  test('codec names are 原声, not a language', () => {
    const rows = youkuAudiosFromPlay({
      audio_tracks: [{ stream_type: 'cmfa1hd3', lang: 'AAC', langcode: 'aac', default: true }],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.label).toBe('AAC')
    expect(rows[0]!.lang).toBe('原声')
  })

  test('nameless default dvd.audiolang still labels 普通话', () => {
    const rows = youkuAudiosFromPlay(
      {
        languages: [{ lang: '普通话', langcode: 'guoyu', main: true }],
        audio_tracks: [{ stream_type: 'cmfa1hd3', lang: 'default', default: true }],
      },
      'XEP1',
    )
    expect(rows[0]!.lang).toBe('普通话')
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
    {
      languages: [
        { lang: '英语', langcode: 'en', vid: 'XEN', main: true },
        { lang: '普通话', langcode: 'guoyu', vid: 'XCN' },
      ],
      audio_tracks: [{ stream_type: 'cmfa1hd3', lang: 'en', langcode: 'en', default: true }],
    },
    [{ vid: 'XCN', data: { audio_tracks: [{ stream_type: 'cmfa1hd3', lang: 'en', langcode: 'en' }] }, lang: '普通话' }],
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
      return { audio_tracks: [{ stream_type: 'cmfa1hd3', lang: 'en', langcode: 'en' }] }
    },
  } as unknown as GwClient
  const opts = await probeOptions(cli, {} as FileConfig, 'youku', 'XEN')
  expect(vids).toEqual(['XEN', 'XCN'])
  expect(opts.audios.map((a) => a.lang)).toEqual(['英语', '普通话'])
  expect(opts.audios.map((a) => a.id)).toEqual(['XEN|cmfa1hd3', 'XCN|cmfa1hd3'])
})

test('probeYouku uses episode languages when play omits languages and UPS says en', async () => {
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
      return { audio_tracks: [{ stream_type: 'cmfa1hd3', lang: 'en', langcode: 'en' }] }
    },
  } as unknown as GwClient
  const opts = await probeOptions(cli, {} as FileConfig, 'youku', 'XEN', {
    languages: [
      { vid: 'XEN', lang: '英语' },
      { vid: 'XCN', lang: '普通话' },
    ],
  })
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

import {
  audiosFromTencent,
  qualitiesFromTencentFormats,
  qualityFormatId,
  qualityResolution,
  QUALITY_COLS,
  sortTencentQualities,
  tencentPlayQualityInput,
} from './quality.ts'
import { displayWidth } from './text.ts'
import { column } from './text.ts'

describe('qualitiesFromTencentFormats', () => {
  test('maps soft/hard ladder with real sizes and pairs by name', () => {
    const rows = qualitiesFromTencentFormats([
      { id: 3, name: 'fhd', cname: '蓝光', caption: 'hard', width: 1920, height: 1080, vfps: 25, fs: 1_200_000_000, persona: 'l3_hard' },
      { id: 3, name: 'fhd', cname: '蓝光', caption: 'soft', width: 1920, height: 1080, vfps: 25, fs: 1_100_000_000, persona: 'l3_soft' },
      { id: 322095, name: 'maxplus', cname: '臻彩MAX+', caption: 'soft', width: 3840, height: 2160, vfps: 60, fs: 5_200_000_000, persona: 'l3_soft' },
      { id: 322095, name: 'maxplus', cname: '臻彩MAX+', caption: 'hard', width: 3840, height: 2160, vfps: 60, fs: 5_400_000_000, persona: 'l3_hard' },
      { id: 10017, name: 'source', cname: '原画/source', fs: 25_440_000_000, persona: 'source' },
      { id: 9, name: 'hd', cname: '高清', caption: 'soft', width: 848, height: 480, fs: 400_000_000, persona: '2741517771455_soft' },
      { id: 320001, name: 'audio', cname: '音轨', caption: 'soft', persona: 'l3_soft', fs: 12_000_000 },
      { id: 320001, name: 'audio', cname: '音轨', caption: 'hard', persona: 'l3_hard', fs: 12_000_000 },
    ])
    expect(rows.map((r) => r.stream)).toEqual([
      'maxplus',
      'maxplus',
      'fhd',
      'fhd',
      'hd',
      'source',
    ])
    expect(rows.every((r) => r.stream !== 'audio')).toBe(true)
    expect(rows.map((r) => r.caption)).toEqual(['soft', 'hard', 'soft', 'hard', 'soft', undefined])
    expect(rows.map((r) => r.group)).toEqual(['main', 'main', 'main', 'main', 'encode', 'source'])
    expect(rows[0]!.size).toBe(5_200_000_000)
    expect(rows[0]!.fps).toBe(60)
    expect(rows[0]!.formatId).toBe('322095')
    expect(qualityFormatId(rows[0]!)).toBe('322095')
    expect(rows.at(-1)!.size).toBe(25_440_000_000)
    expect(rows.at(-1)!.group).toBe('source')
  })

  test('encode personas sort after main ladder', () => {
    const rows = sortTencentQualities(
      qualitiesFromTencentFormats([
        { id: 1, name: 'uhd', caption: 'soft', persona: 'default_soft', fs: 9 },
        { id: 2, name: 'uhd', caption: 'soft', persona: 'l3_soft', fs: 8 },
        { id: 3, name: 'source', persona: 'source', fs: 99 },
      ]),
    )
    expect(rows.map((r) => r.group)).toEqual(['main', 'encode', 'source'])
  })
})

describe('tencentPlayQualityInput', () => {
  test('passes defn + caption for ladder rows', () => {
    expect(
      tencentPlayQualityInput({ quality: 'maxplus', stream: 'maxplus', caption: 'soft' }),
    ).toEqual({ defn: 'maxplus', caption: 'soft' })
  })

  test('source rows force source=1 and companion defn', () => {
    expect(tencentPlayQualityInput({ stream: 'source', group: 'source' })).toEqual({
      source: '1',
      defn: 'uhd',
    })
  })

  test('strips composite id to defn name', () => {
    expect(tencentPlayQualityInput({ quality: 'fhd|soft|3|l3_soft' })).toEqual({ defn: 'fhd' })
  })
})

describe('audiosFromTencent', () => {
  test('prefers audio_tracks from gateway al.ai', () => {
    const rows = audiosFromTencent({
      audio_tracks: [
        { id: '7', name: 'db', cname: '杜比音效' },
        { id: '1', name: 'aac', cname: '标准音轨' },
      ],
      formats: [
        { id: 320001, name: 'audio', cname: '音轨', caption: 'soft' },
      ],
    })
    expect(rows.map((a) => a.label)).toEqual(['杜比音效', '标准音轨'])
    expect(rows.map((a) => a.id)).toEqual(['7', '1'])
    expect(rows[0]!.isDefault).toBe(true)
    expect(rows.every((a) => a.selected)).toBe(true)
  })

  test('promotes name=audio formats when audio_tracks missing', () => {
    const rows = audiosFromTencent({
      formats: [
        { id: 320001, name: 'audio', cname: '音轨', caption: 'soft', persona: 'l3_soft' },
        { id: 320001, name: 'audio', cname: '音轨', caption: 'hard', persona: 'l3_hard' },
        { id: 3, name: 'fhd', cname: '蓝光', caption: 'soft' },
      ],
    })
    expect(rows).toHaveLength(2)
    expect(rows.map((a) => a.label)).toEqual(['音轨（软）', '音轨（硬）'])
    expect(rows.map((a) => a.lang)).toEqual(['软', '硬'])
  })

  test('leaves audios empty when only muxed video qualities exist', () => {
    expect(
      audiosFromTencent({
        formats: [{ id: 3, name: 'fhd', cname: '蓝光', caption: 'soft', width: 1920, height: 1080 }],
      }),
    ).toEqual([])
  })
})

describe('quality table alignment helpers', () => {
  test('ASCII resolution width matches terminal cells for 4K', () => {
    // 3840 + x + 2160 = 9 cells; column is 10 so one pad remains.
    expect(qualityResolution(3840, 2160)).toBe('3840x2160')
    expect(displayWidth(qualityResolution(3840, 2160))).toBe(9)
    expect(displayWidth('3840x2160')).toBe(9)
    expect(QUALITY_COLS.res).toBe(10)
    // displayWidth counts × as 1, but Windows Terminal often paints it 2-wide —
    // that is the misalignment we avoid by using ASCII x.
    expect(displayWidth('3840×2160')).toBe(9)
  })

  test('header and row cell widths match QUALITY_COLS cell-for-cell', () => {
    const headers = ['档位/名称', '字幕', '分辨率', 'fps', '体积', 'id', 'DRM']
    const keys = ['label', 'caption', 'res', 'fps', 'size', 'id', 'drm'] as const
    const sample = {
      id: 'maxplus|soft|322095|l3_soft',
      formatId: '322095',
      label: '臻彩MAX+',
      title: 'maxplus',
      size: 5_200_000_000,
      width: 3840,
      height: 2160,
      codec: 'H265',
      drm: '',
      caption: 'soft',
      fps: 60,
      stream: 'maxplus',
      group: 'main' as const,
    }
    const cells = [
      sample.label,
      '软',
      qualityResolution(sample.width, sample.height),
      String(sample.fps),
      '4.8 GB',
      qualityFormatId(sample),
      '无',
    ]
    for (let i = 0; i < keys.length; i++) {
      const w = QUALITY_COLS[keys[i]!]
      expect(displayWidth(column(headers[i]!, w))).toBe(w)
      expect(displayWidth(column(cells[i]!, w))).toBe(w)
    }
    const fixed =
      QUALITY_COLS.mark +
      QUALITY_COLS.label +
      QUALITY_COLS.caption +
      QUALITY_COLS.res +
      QUALITY_COLS.fps +
      QUALITY_COLS.size +
      QUALITY_COLS.id +
      QUALITY_COLS.drm
    expect(fixed).toBeLessThanOrEqual(60)
  })
})

test('probeTencent returns audios from audio_tracks', async () => {
  const cli = {
    extra: () => ({}),
    invoke: async () => ({
      formats: [
        { id: 322095, name: 'maxplus', cname: '臻彩MAX+', caption: 'soft', width: 3840, height: 2160, persona: 'l3_soft' },
        { id: 320001, name: 'audio', cname: '音轨', caption: 'soft', persona: 'l3_soft' },
      ],
      audio_tracks: [{ id: '7', name: 'db', cname: '杜比音效' }],
    }),
  } as unknown as GwClient
  const opts = await probeOptions(cli, {} as FileConfig, 'tencent', 'vid1')
  expect(opts.qualities.map((q) => q.stream)).toEqual(['maxplus'])
  expect(opts.audios.map((a) => a.label)).toEqual(['杜比音效'])
})
