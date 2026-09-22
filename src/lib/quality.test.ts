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

test('probeYouku keeps per-stream fps and lists the largest file first', async () => {
  const cli = {
    extra: () => ({}),
    invoke: async () => ({
      streams: [
        { stream_type: 'cmfv5hd4_hdr', media_type: 'video', playlist_url: 'https://cdn/hdr', width: 3840, height: 1608, size: 100, fps: 60 },
        { stream_type: 'mp4hd3', media_type: 'video', playlist_url: 'https://cdn/1080', width: 1920, height: 808, size: 500, fps: 25 },
      ],
      video_types: [
        { stream_type: 'cmfv5hd4_hdr', name: 'HDR10' },
        { stream_type: 'mp4hd3', name: '1080P' },
      ],
    }),
  } as unknown as GwClient
  const opts = await probeOptions(cli, {} as FileConfig, 'youku', 'VID')
  expect(opts.qualities.map((q) => q.label)).toEqual(['1080P', 'HDR10'])
  expect(opts.qualities.map((q) => q.size)).toEqual([500, 100])
  expect(opts.qualities.map((q) => q.fps)).toEqual([25, 60])
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
  tencentAudioDownloadPlan,
  isTencentEm93,
  qualitiesFromTencentFormats,
  qualityFormatId,
  qualityResolution,
  QUALITY_COLS,
  qualityCaptionText,
  qualityChoiceLabel,
  qualityFpsText,
  qualityHdrText,
  sortTencentQualities,
  tencentCatalogProbeInput,
  tencentEncodeTag,
  tencentFormatHDR,
  tencentPersonaKey,
  tencentPlayQualityInput,
  tencentQualityBaseName,
  tencentQualityDisplayLabel,
  TENCENT_EM93_STATUS,
  TENCENT_HEVC_FPS_ENCODE_TAGS,
} from './quality.ts'
import { clip, column, displayWidth } from './text.ts'

describe('qualitiesFromTencentFormats', () => {
  test('maps soft/hard ladder with real sizes and pairs by name', () => {
    const rows = qualitiesFromTencentFormats([
      { id: 3, name: 'fhd', cname: '蓝光', caption: 'hard', width: 1920, height: 1080, vfps: 25, fs: 1_200_000_000, persona: 'l3_hard' },
      { id: 3, name: 'fhd', cname: '蓝光', caption: 'soft', width: 1920, height: 1080, vfps: 25, fs: 1_100_000_000, persona: 'l3_soft' },
      { id: 322095, name: 'maxplus', cname: '臻彩MAX+', caption: 'soft', width: 3840, height: 2160, vfps: 60, fs: 5_200_000_000, persona: 'l3_soft' },
      { id: 322095, name: 'maxplus', cname: '臻彩MAX+', caption: 'hard', width: 3840, height: 2160, vfps: 60, fs: 5_400_000_000, persona: 'l3_hard' },
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
    ])
    expect(rows.every((r) => r.stream !== 'audio')).toBe(true)
    expect(rows.map((r) => r.caption)).toEqual(['hard', 'soft', 'hard', 'soft', 'soft'])
    expect(rows.map((r) => r.group)).toEqual(['main', 'main', 'main', 'main', 'encode'])
    const max = rows.find((r) => r.stream === 'maxplus' && r.caption === 'soft')!
    expect(max.size).toBe(5_200_000_000)
    expect(max.fps).toBe(60)
    expect(max.formatId).toBe('322095')
    expect(qualityFormatId(max)).toBe('322095')
    expect(rows[0]!.size).toBe(5_400_000_000)
    expect(rows.at(-1)!.size).toBe(400_000_000)
  })

  test('keeps soft/hard and HDR/HDR10/SDR on MAX+ and MAX rows', () => {
    const rows = qualitiesFromTencentFormats([
      { id: 322095, name: 'maxplus', sname: '臻彩MAX+', cname: '臻彩MAX+;(4K)', caption: 'soft', width: 3840, height: 2160, vfps: 60 },
      { id: 322175, name: 'maxplus', sname: '臻彩MAX+', cname: '臻彩MAX+;(4K)', caption: 'hard', width: 3840, height: 2160, vfps: 60 },
      { id: 2, name: 'suhd', sname: '臻彩 MAX', cname: '臻彩 MAX;(4K)', caption: 'soft' },
      { id: 3, name: 'max', sname: '臻彩MAX', caption: 'hard', hdr: 'sdr' },
      { id: 4, name: 'uhd', sname: '超高清SDR', cname: '超高清SDR;(4K)', caption: 'soft' },
      { id: 5, name: 'fhd', sname: '蓝光', caption: 'hard', hdr10enh: 1 },
      { id: 6, name: 'fhd', sname: '蓝光', caption: 'soft' },
      { id: 7, name: 'maxplus', caption: 'soft' },
      { id: 8, name: 'max', caption: 'hard' },
    ])
    const pick = (stream: string, caption?: string) =>
      rows.find((r) => r.stream === stream && r.caption === caption)!
    expect(pick('maxplus', 'soft').hdr).toBe('hdr')
    expect(pick('maxplus', 'hard').hdr).toBe('hdr')
    expect(pick('maxplus', 'soft').fps).toBe(60)
    expect(qualityFpsText(60)).toBe('60fps')
    expect(qualityFpsText(0)).toBe('')
    expect(qualityChoiceLabel(pick('maxplus', 'soft'))).toBe('臻彩MAX+ · HDR · 60fps · 软字幕')
    expect(qualityChoiceLabel(pick('maxplus', 'hard'))).toBe('臻彩MAX+ · HDR · 60fps · 硬字幕')
    expect(pick('suhd', 'soft').label).toBe('臻彩 MAX')
    expect(pick('suhd', 'soft').hdr).toBe('sdr')
    expect(qualityChoiceLabel(pick('suhd', 'soft'))).toBe('臻彩 MAX · SDR · 软字幕')
    expect(pick('max', 'hard').hdr).toBe('sdr')
    expect(qualityHdrText(pick('max', 'hard').hdr)).toBe('SDR')
    expect(pick('uhd', 'soft').hdr).toBe('sdr')
    expect(qualityChoiceLabel(pick('uhd', 'soft'))).toBe('超高清SDR · 软字幕')
    expect(pick('fhd', 'hard').hdr).toBe('hdr10')
    expect(qualityHdrText('hdr10')).toBe('HDR10')
    expect(qualityCaptionText('soft')).toBe('软字幕')
    expect(qualityCaptionText('hard')).toBe('硬字幕')
    expect(pick('fhd', 'soft').hdr).toBeUndefined()
    expect(rows.find((r) => r.stream === 'maxplus' && r.label === 'MAX+')!.hdr).toBe('hdr')
    expect(rows.find((r) => r.label === 'MAX')!.hdr).toBe('sdr')
    expect(tencentFormatHDR({ name: 'fhd', sname: '蓝光' })).toBe('')
    expect(tencentFormatHDR({ hdr: 'hdr10', name: 'maxplus' })).toBe('hdr10')
  })

  test('sorts by file size, largest first', () => {
    const rows = sortTencentQualities(
      qualitiesFromTencentFormats([
        { id: 1, name: 'uhd', caption: 'soft', persona: 'default_soft', fs: 9 },
        { id: 2, name: 'uhd', caption: 'soft', persona: 'l3_soft', fs: 8 },
      ]),
    )
    expect(rows.map((r) => r.size)).toEqual([9, 8])
    expect(rows.map((r) => r.group)).toEqual(['encode', 'main'])
  })
})

describe('tencentPlayQualityInput', () => {
  test('passes defn + caption for ladder rows', () => {
    expect(
      tencentPlayQualityInput({ quality: 'maxplus', stream: 'maxplus', caption: 'soft' }),
    ).toEqual({ defn: 'maxplus', caption: 'soft' })
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
    expect(rows.map((a) => a.codec)).toEqual(['E-AC-3', 'AAC'])
    expect(rows.map((a) => a.lang)).toEqual(['原声', '原声'])
    expect(rows[0]!.isDefault).toBe(true)
    expect(rows.every((a) => a.embedded)).toBe(true)
  })

  test('keeps a real playlist separate from the Chinese title', () => {
    const rows = audiosFromTencent({
      audio_tracks: [
        { id: '2', name: '5.1环绕声', cname: '5.1环绕声', playlist_url: 'https://cdn.example/51.m3u8' },
        { id: '9', name: '杜比音效', cname: '杜比音效', url: 'https://cdn.example/db.m3u8', lang: 'zh-cn' },
      ],
    })
    expect(rows.map((a) => a.codec)).toEqual(['AC-3', 'E-AC-3'])
    expect(rows.map((a) => a.lang)).toEqual(['原声', 'zh-cn'])
    expect(rows.map((a) => a.url)).toEqual(['https://cdn.example/51.m3u8', 'https://cdn.example/db.m3u8'])
    expect(rows.every((a) => a.selected && !a.embedded)).toBe(true)
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

describe('tencentAudioDownloadPlan', () => {
  test('matches selected ids to playlist urls and names the ones without', () => {
    const plan = tencentAudioDownloadPlan(
      {
        audio_tracks: [
          { id: '2', playlist_url: 'https://cdn.example/51.m3u8' },
          { id: '9', url: 'https://cdn.example/db.m3u8' },
        ],
      },
      [
        { id: '2', label: '5.1环绕声', lang: '原声' },
        { id: '9', label: '杜比音效', lang: '原声' },
        { id: '1', label: '标准音轨', lang: '原声' },
      ],
    )
    expect(plan.files.map((f) => f.url)).toEqual(['https://cdn.example/51.m3u8', 'https://cdn.example/db.m3u8'])
    expect(plan.missing).toEqual(['标准音轨'])
  })
})

describe('quality table alignment helpers', () => {
  test('HDR and caption labels fit without collapsing to a dot ellipsis', () => {
    for (const text of ['HDR', 'HDR10', 'SDR', '软字幕', '硬字幕']) {
      const fitted = column(text, Math.max(12, displayWidth(text) + 2))
      expect(fitted.includes(text)).toBe(true)
      expect(fitted.includes('..')).toBe(false)
    }
    const cut = clip('HDR10', 4)
    expect(cut.startsWith('HD')).toBe(true)
    expect(cut.endsWith('..')).toBe(true)
    expect(displayWidth(cut)).toBeLessThanOrEqual(4)
  })

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
    const headers = ['档位/名称', '字幕', '分辨率', 'fps', '体积', 'id', '编码']
    const keys = ['label', 'caption', 'res', 'fps', 'size', 'id', 'encode'] as const
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
      encodeTag: undefined as string | undefined,
    }
    const cells = [
      sample.label,
      '软',
      qualityResolution(sample.width, sample.height),
      String(sample.fps),
      '4.8 GB',
      qualityFormatId(sample),
      '—',
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
      QUALITY_COLS.encode
    expect(fixed).toBeLessThanOrEqual(60)
  })
})

describe('tencentEncodeTag mapping', () => {
  test('strips soft/hard and 软/硬 suffixes', () => {
    expect(tencentPersonaKey('default_软')).toBe('default')
    expect(tencentPersonaKey('h264_硬')).toBe('h264')
    expect(tencentPersonaKey('2741527771455_soft')).toBe('2741527771455')
    expect(tencentPersonaKey('61111111016223_hard')).toBe('61111111016223')
  })

  test('maps default / h264 / known HEVC ids / unknown', () => {
    expect(tencentEncodeTag('default_软')).toBe('默认')
    expect(tencentEncodeTag('h264_软')).toBe('H264')
    expect(tencentEncodeTag('l3_soft')).toBe('')
    const expected = ['HEVC·A', 'HEVC·B', 'HEVC·C', 'HEVC·D', 'HEVC·E', 'HEVC·F']
    const ids = Object.keys(TENCENT_HEVC_FPS_ENCODE_TAGS)
    expect(ids).toEqual([
      '2741517771455',
      '2741527771455',
      '9741517771455',
      '5741917771647',
      '61111111016223',
      '2741527771647',
    ])
    expect(ids.map((id) => tencentEncodeTag(`${id}_硬`))).toEqual(expected)
    expect(tencentEncodeTag('9999999991234_软')).toBe('编码·1234')
  })
})

describe('tencent quality label disambiguation', () => {
  test('prefers sname and strips ;(4K) from cname', () => {
    expect(tencentQualityBaseName({ sname: '臻彩MAX+', cname: '臻彩MAX+;(4K)' }, 'maxplus')).toBe('臻彩MAX+')
    expect(tencentQualityBaseName({ cname: '臻彩MAX+;(4K)' }, 'maxplus')).toBe('臻彩MAX+')
  })

  test('main/default stay clean; encode variants get · tag', () => {
    expect(tencentQualityDisplayLabel('臻彩MAX+', 'main', '', 'l3_soft')).toBe('臻彩MAX+')
    expect(tencentQualityDisplayLabel('臻彩MAX+', 'encode', '默认', 'default_软')).toBe('臻彩MAX+')
    expect(tencentQualityDisplayLabel('臻彩MAX+', 'encode', 'H264', 'h264_软')).toBe('臻彩MAX+ · H264')
    expect(tencentQualityDisplayLabel('臻彩MAX+', 'encode', 'HEVC·B', '2741527771455_硬')).toBe(
      '臻彩MAX+ · HEVC·B',
    )
  })

  test('encode=all catalog distinguishes same cname rows', () => {
    const rows = qualitiesFromTencentFormats([
      {
        id: 322095,
        name: 'maxplus',
        cname: '臻彩MAX+;(4K)',
        sname: '臻彩MAX+',
        caption: 'soft',
        width: 3840,
        height: 2160,
        persona: 'l3_soft',
        fs: 5_000_000_000,
      },
      {
        id: 322095,
        name: 'maxplus',
        cname: '臻彩MAX+;(4K)',
        sname: '臻彩MAX+',
        caption: 'soft',
        width: 3840,
        height: 2160,
        persona: 'default_软',
        fs: 5_100_000_000,
      },
      {
        id: 322001,
        name: 'maxplus',
        cname: '臻彩MAX+;(4K)',
        sname: '臻彩MAX+',
        caption: 'soft',
        width: 3840,
        height: 2160,
        persona: 'h264_软',
        fs: 6_000_000_000,
      },
      {
        id: 322002,
        name: 'maxplus',
        cname: '臻彩MAX+;(4K)',
        sname: '臻彩MAX+',
        caption: 'hard',
        width: 3840,
        height: 2160,
        persona: '2741527771455_硬',
        fs: 5_200_000_000,
      },
      {
        id: 322003,
        name: 'maxplus',
        cname: '臻彩MAX+;(4K)',
        sname: '臻彩MAX+',
        caption: 'soft',
        width: 3840,
        height: 2160,
        persona: '2741527771455_软',
        fs: 5_150_000_000,
      },
    ])
    const byPersona = Object.fromEntries(rows.map((r) => [r.persona!, r]))
    expect(byPersona['l3_soft']!.label).toBe('臻彩MAX+')
    expect(byPersona['l3_soft']!.group).toBe('main')
    expect(byPersona['l3_soft']!.encodeTag).toBeUndefined()
    expect(byPersona['default_软']!.label).toBe('臻彩MAX+')
    expect(byPersona['default_软']!.encodeTag).toBe('默认')
    expect(byPersona['default_软']!.group).toBe('encode')
    expect(byPersona['h264_软']!.label).toBe('臻彩MAX+ · H264')
    expect(byPersona['h264_软']!.encodeTag).toBe('H264')
    expect(byPersona['2741527771455_软']!.label).toBe('臻彩MAX+ · HEVC·B')
    expect(byPersona['2741527771455_硬']!.label).toBe('臻彩MAX+ · HEVC·B')
    expect(byPersona['2741527771455_软']!.caption).toBe('soft')
    expect(byPersona['2741527771455_硬']!.caption).toBe('hard')
    expect(rows.map((r) => r.size)).toEqual([
      6_000_000_000,
      5_200_000_000,
      5_150_000_000,
      5_100_000_000,
      5_000_000_000,
    ])
  })
})

describe('tencentCatalogProbeInput defaults', () => {
  test('default probe is caption=soft without source/encode', () => {
    expect(tencentCatalogProbeInput({} as FileConfig, 'x4102kqtje5')).toEqual({
      vid: 'x4102kqtje5',
      caption: 'soft',
    })
  })

  test('opt-in flags add caption=all, source=1, encode=all', () => {
    expect(
      tencentCatalogProbeInput(
        { tencentCaptionAll: true, tencentProbeSource: true, tencentEncodeAll: true } as FileConfig,
        'vid1',
      ),
    ).toEqual({
      vid: 'vid1',
      caption: 'all',
      source: '1',
      encode: 'all',
    })
  })
})

describe('isTencentEm93', () => {
  test('detects em=93 / 93.x / 限制播放', () => {
    expect(isTencentEm93({ em: '93', has_url: false })).toBe(true)
    expect(isTencentEm93({ em: '93.2', msg: '限制播放' })).toBe(true)
    expect(isTencentEm93({ code: '93.1' })).toBe(true)
    expect(isTencentEm93({ msg: '限制播放' })).toBe(true)
    expect(isTencentEm93({ em: '0', formats: [{ name: 'fhd' }] })).toBe(false)
  })
})

test('probeTencent returns audios from audio_tracks and uses soft probe', async () => {
  let seen: Record<string, string> | undefined
  const cli = {
    extra: () => ({}),
    invoke: async (_p: string, _a: string, input: Record<string, string>) => {
      seen = input
      return {
        formats: [
          { id: 322095, name: 'maxplus', cname: '臻彩MAX+', caption: 'soft', width: 3840, height: 2160, persona: 'l3_soft' },
          { id: 320001, name: 'audio', cname: '音轨', caption: 'soft', persona: 'l3_soft' },
        ],
        audio_tracks: [{ id: '7', name: 'db', cname: '杜比音效' }],
      }
    },
  } as unknown as GwClient
  const opts = await probeOptions(cli, {} as FileConfig, 'tencent', 'vid1')
  expect(seen).toEqual({ vid: 'vid1', caption: 'soft' })
  expect(seen?.source).toBeUndefined()
  expect(seen?.encode).toBeUndefined()
  expect(opts.qualities.map((q) => q.stream)).toEqual(['maxplus'])
  expect(opts.audios.map((a) => a.label)).toEqual(['杜比音效'])
})

test('probeTencent surfaces em=93 Chinese status instead of empty/static ladder', async () => {
  const cli = {
    extra: () => ({}),
    invoke: async () => ({ em: '93', has_url: false, msg: '限制播放' }),
  } as unknown as GwClient
  await expect(probeOptions(cli, {} as FileConfig, 'tencent', 'x4102kqtje5')).rejects.toThrow(
    TENCENT_EM93_STATUS,
  )
})
