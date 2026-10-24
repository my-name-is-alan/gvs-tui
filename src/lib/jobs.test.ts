import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobHub, tencentCipher, tencentMirrors, bindYoukuAudioTracksToTask, cleanupOutputCaches, jobNaming, jobTitle, muxTrackTitle, patchJob, trackVid, youkuAudioFetchPlan, youkuDRM, MEDIA_PROBE_PROVIDERS, shouldMarkSubtitleFlags, type DlTask, originalAudioLanguage } from './jobs.ts'
import { youkuAudioPlaylist, youkuUsesSeparateAudio, youkuVideoPlaylist } from './media.ts'
import { defaultConfig, type FileConfig } from './config.ts'
import type { GwClient } from './client.ts'
import { completedFilename, filename, folder } from './name.ts'

function task(partial: Partial<DlTask>): DlTask {
  return {
    provider: 'youku',
    title: '英语版',
    series: '第九区',
    vid: 'XEN',
    season: 1,
    episode: 1,
    height: 0,
    quality: '4K',
    group: '',
    codec: '',
    tmdbId: 0,
    nameDots: '',
    year: 2009,
    plot: '',
    ...partial,
  }
}

test('mux track title uses the probed codec, not the catalog slogan', () => {
  expect(muxTrackTitle('原声', 'AAC 2.0')).toBe('AAC 2.0')
  expect(muxTrackTitle('', 'DDP 2.0')).toBe('DDP 2.0')
  expect(muxTrackTitle('粤语', 'DTS 5.1')).toBe('粤语 DTS 5.1')
})

test('audio 0:0 is full-block CBC and must be decrypted', () => {
  const drm = youkuDRM({ drm: { need_decrypt: true, pattern_audio: '0:0', content_key_hex: 'a'.repeat(32) } })
  expect(drm.audioEnc).toBe(true)
  expect(drm.reKey).toBe('a'.repeat(32))
  expect(youkuDRM({ drm: { actually_clear: true } }).audioEnc).toBe(false)
  expect(youkuDRM({ drm: { need_decrypt: false } }).videoEnc).toBe(false)
})

test('Tencent ChaCha20 drm becomes an RE custom HLS cipher', () => {
  expect(tencentCipher({ drm: { need_decrypt: false, enc: 0 } })).toBeUndefined()
  expect(tencentCipher({})).toBeUndefined()
  expect(tencentCipher({ drm: { need_decrypt: true, enc: '1', content_key_hex: 'aa', iv_hex: 'bb' } }))
    .toEqual({ method: 'CHACHA20', key: 'aa', iv: 'bb' })
  expect(() => tencentCipher({ drm: { need_decrypt: true, enc: 1 } })).toThrow('没有返回可用密钥')
  expect(() => tencentCipher({ drm: { enc: '1', note: 'chacha20.js not found' } })).toThrow('chacha20.js not found')
  expect(() => tencentCipher({ drm: { enc: 2 } })).toThrow('Widevine')
  expect(() => tencentCipher({
    drm: { enc: 1, content_key_hex: '00'.repeat(32), iv_hex: '11'.repeat(12), playback_verified: false },
  })).toThrow(/全为零/)
  expect(() => tencentCipher({
    drm: { enc: 1, content_key_hex: 'ab'.repeat(32), iv_hex: '00'.repeat(12) },
  })).toThrow(/全为零/)
})

test('Tencent mirrors keep the picked URL first and never cross streams', () => {
  const data = { video: { url: 'a', urls: ['a', 'b', 'c'] } }
  expect(tencentMirrors(data, 'b')).toEqual(['b', 'a', 'c'])
  expect(tencentMirrors(data, 'fmt-url')).toEqual(['fmt-url'])
  expect(tencentMirrors({}, 'x')).toEqual(['x'])
})

test('movie job title uses 英语版 not E01', () => {
  expect(jobTitle(task({ kind: 'movie', edition: '英语版' }))).toBe('第九区 英语版 4K')
})

test('phase change clears stale progress text', () => {
  const jobs = [{ id: 1, title: 'test', status: '下载', pct: 0.6, log: '95%', err: '' }]
  patchJob(jobs, { id: 1, status: '解密', pct: 0.7, log: '', err: '' })
  expect(jobs[0]!.log).toBe('')
  expect(jobs[0]!.status).toBe('解密')
})
test('show job title still uses E01', () => {
  expect(jobTitle(task({ title: '危机初现' }))).toBe('第九区 E01 危机初现 4K')
  expect(jobTitle(task({ title: '第九区' }))).toBe('第九区 E01 4K')
})

test('episode-title switch is pinned to the task and controls both legacy and measured names, not display titles or folders', () => {
  const cfg = { ...defaultConfig(), releaseGroup: 'WF', includeEpisodeTitle: false }
  const specs = { status: 'probed' as const, width: 3840, height: 1608, codec: 'hevc', fps: 25,
    dynamicRange: 'SDR', audio: { status: 'confirmed' as const, codec: 'eac3', channels: 2 } }
  for (const [provider, platform] of [['youku', 'YOUKU'], ['tencent', 'TX'], ['iq', 'IQ'], ['iqcn', 'IQIYI']]) {
    const base = task({ provider, kind: 'show', namingVersion: 1, title: '朱门盛景，终究一场梦', series: '一瓯春',
      year: 2026, episode: 29, group: 'WF', height: 2160, codec: 'HEVC' })
    const on = { ...base, includeEpisodeTitle: true }
    const off = JSON.parse(JSON.stringify({ ...base, includeEpisodeTitle: false })) as DlTask
    const onNaming = jobNaming(on, cfg), offNaming = jobNaming(off, { ...cfg, includeEpisodeTitle: true })
    expect(completedFilename(onNaming, specs)).toBe(`一瓯春.S01E29.朱门盛景.终究一场梦.2026.2160p.${platform}.WEB-DL.HEVC.DDP.2.0-WF.mkv`)
    expect(completedFilename(offNaming, specs)).toBe(`一瓯春.S01E29.2026.2160p.${platform}.WEB-DL.HEVC.DDP.2.0-WF.mkv`)
    expect(filename(onNaming)).toContain('.S01E29.朱门盛景.终究一场梦.')
    expect(filename(offNaming)).toContain('.S01E29.2026.')
    expect(jobTitle(off)).toBe(jobTitle(on))
    expect(folder(offNaming, '/library')).toBe(folder(onNaming, '/library'))
    expect(completedFilename(jobNaming({ ...base, namingVersion: undefined }, cfg), specs)).toBe(completedFilename(onNaming, specs))
    expect(completedFilename(jobNaming({ ...off, kind: 'movie' }, cfg), specs))
      .toBe(completedFilename(jobNaming({ ...on, kind: 'movie' }, cfg), specs))
  }
})

test('youku playlists use stream playlist_url not CMAF segments', () => {
  const data = {
    streams: [{ stream_type: 'mp4hd3', media_type: 'video', playlist_url: 'https://v.m3u8' }],
    video: { playlist_url: 'https://fallback.m3u8' },
    audio_tracks: [
      { stream_type: 'aac', playlist_url: 'https://a.m3u8', default: true },
      { stream_type: 'atmos', playlist_url: 'https://atmos.m3u8' },
    ],
  }
  expect(youkuVideoPlaylist(data, 'mp4hd3')).toBe('https://v.m3u8')
  expect(youkuAudioPlaylist(data, '')).toBe('https://a.m3u8')
  expect(youkuAudioPlaylist(data, 'aac')).toBe('https://a.m3u8')
  expect(youkuAudioPlaylist(data, 'XEN|atmos')).toBe('https://atmos.m3u8')
  expect(youkuAudioPlaylist(data, 'atmos')).toBe('https://atmos.m3u8')
})

test('youku audio download does not substitute the mandarin playlist for cantonese', () => {
  const data = {
    audio_tracks: [
      { stream_type: 'cmfa1hd3', lang: '普通话', langcode: 'guoyu', playlist_url: 'https://zh.m3u8', default: true },
      { stream_type: 'cmfa1hd3', lang: '粤语', langcode: 'yue', playlist_url: 'https://yue.m3u8' },
      { stream_type: 'cmfa4hd4_51', lang: '普通话', langcode: 'guoyu', playlist_url: 'https://zh-dolby.m3u8', default: true },
    ],
  }
  expect(youkuAudioPlaylist(data, 'YUE|cmfa1hd3|yue', '粤语')).toBe('https://yue.m3u8')
  expect(youkuAudioPlaylist(data, 'ZH|cmfa1hd3|zh', '普通话')).toBe('https://zh.m3u8')
  expect(youkuAudioPlaylist(data, 'YUE|cmfa4hd4_51|yue', '粤语')).toBe('')
})

test('youku jobs never overlap so two editions cannot mix CENC keys', async () => {
  const began: string[] = []
  const started: Record<string, () => void> = {}
  const whenStarted = (vid: string) => new Promise<void>(r => { started[vid] = r })
  const enStarted = whenStarted('en')
  const zhStarted = whenStarted('zh')
  const hStarted = whenStarted('h')
  const release: Record<string, () => void> = {}
  let youkuLive = 0
  let youkuPeak = 0
  let live = 0
  let peak = 0
  const hub = new JobHub(() => {}, async (_e, _cfg, _cli, _id, t) => {
    live++
    peak = Math.max(peak, live)
    if (t.provider === 'youku') {
      youkuLive++
      youkuPeak = Math.max(youkuPeak, youkuLive)
    }
    began.push(t.vid)
    started[t.vid]!()
    await new Promise<void>(r => { release[t.vid] = r })
    live--
    if (t.provider === 'youku') youkuLive--
  })
  const cfg = {} as FileConfig
  const cli = {} as GwClient
  hub.enqueue(cfg, cli, 1, task({ kind: 'movie', edition: '英语版', vid: 'en' }))
  hub.enqueue(cfg, cli, 2, task({ kind: 'movie', edition: '国语版', vid: 'zh' }))
  hub.enqueue(cfg, cli, 3, task({ provider: 'hongguo', vid: 'h' }))
  await Promise.all([enStarted, hStarted])
  expect(began).toEqual(['en', 'h'])
  expect(youkuPeak).toBe(1)
  expect(peak).toBe(2)
  release.en!()
  await zhStarted
  expect(began).toEqual(['en', 'h', 'zh'])
  expect(youkuPeak).toBe(1)
  release.zh!()
  release.h!()
})

test('finished download removes leftover cache folders next to the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-cache-'))
  try {
    mkdirSync(join(dir, '.re-old'))
    mkdirSync(join(dir, '.mux-timing-old'))
    writeFileSync(join(dir, '.re-old', 'seg.bin'), 'x')
    writeFileSync(join(dir, 'District.9.2009.mkv'), 'ok')
    cleanupOutputCaches(dir)
    expect(readdirSync(dir)).toEqual(['District.9.2009.mkv'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('youku CMAF always requires separate audio and never silently changes a selected stream', () => {
  const hq = {
    audio_delivery: 'separate',
    video: { stream_type: 'cmfv5hd4_dolbyvision_hfr_hbr_hq', playlist_url: 'https://v.m3u8' },
    audio_tracks: [{ stream_type: 'cmfa4hd5_atmos51', playlist_url: 'https://a.m3u8', default: true }],
  }
  expect(youkuUsesSeparateAudio(hq, 'cmfv5hd4_dolbyvision_hfr_hbr_hq')).toBe(true)
  expect(youkuUsesSeparateAudio(hq, '')).toBe(true)

  const tv = {
    audio_delivery: 'muxed',
    video: { stream_type: 'hls5hd3', playlist_url: 'https://hls.m3u8' },
    // leftover HQ inventory must NOT force separate download on TV/App
    audio_tracks: [{ stream_type: 'cmfa4hd5_atmos51', playlist_url: 'https://hq-a.m3u8' }],
  }
  expect(youkuUsesSeparateAudio(tv, 'hls5hd3')).toBe(false)
  expect(() => youkuUsesSeparateAudio(tv, 'hls5hd4_sdr_hfr_hbr_bit10_hq')).toThrow('所选档位')

  // Missing HLS selection must not become the default HQ video.
  expect(() => youkuUsesSeparateAudio(hq, 'hls5hd3')).toThrow('所选档位')
  // A present HLS row keeps its embedded audio despite leftover HQ inventory.
  expect(youkuUsesSeparateAudio({ ...hq, streams: [
    { stream_type: 'hls5hd3', media_type: 'video', playlist_url: 'https://hls.m3u8' },
  ] }, 'hls5hd3')).toBe(false)

  const invOnly = {
    video: { stream_type: 'cmfv5hd4_sdr_hfr_hbr_bit10_hq' },
    audio_tracks: [{ stream_type: 'cmfa1hd3' }],
  }
  expect(() => youkuUsesSeparateAudio(invOnly, 'cmfv5hd4_sdr_hfr_hbr_bit10_hq')).toThrow('所选档位')
})

test('Youku missing selections stop instead of borrowing the default video and audio', () => {
  const hq = 'cmfv5hd4_sdr_hbr_bit10_hq'
  const data = {
    video: { stream_type:hq, playlist_url:'https://hq-video.m3u8' },
    audio_delivery:'separate', audio_tracks:[{ stream_type:'cmfa1hd3', playlist_url:'https://default-aac.m3u8', default:true }],
  }
  expect(() => youkuVideoPlaylist(data, 'mp5hd4')).toThrow('所选档位')
  expect(() => youkuUsesSeparateAudio(data, 'mp5hd4')).toThrow('所选档位')
  expect(youkuVideoPlaylist(data, '')).toBe('https://hq-video.m3u8')
  expect(youkuAudioPlaylist(data, '')).toBe('https://default-aac.m3u8')
  expect(youkuUsesSeparateAudio(data, hq)).toBe(true)
  expect(youkuUsesSeparateAudio({ ...data, audio_delivery:'muxed', audio_tracks:[] }, hq)).toBe(true)
})

test('multi-ep batch does not cross-wire first episode audio onto later episodes', () => {
  // Quality probe ran on EP1 only — audio rows still carry EP1 vids.
  const probedFromEp1 = [
    { id: 'EP1|cmfa4hd5_atmos51', label: '杜比全景声', lang: '普通话', vid: 'EP1' },
    { id: 'EP1EN|cmfa1hd3', label: 'AAC', lang: '英语', vid: 'EP1EN' },
  ]
  const ep1 = task({
    vid: 'EP1',
    episode: 1,
    languages: [
      { vid: 'EP1', lang: '普通话' },
      { vid: 'EP1EN', lang: '英语' },
    ],
  })
  const ep2 = task({
    vid: 'EP2',
    episode: 2,
    languages: [
      { vid: 'EP2', lang: '普通话' },
      { vid: 'EP2EN', lang: '英语' },
    ],
  })
  const ep3 = task({ vid: 'EP3', episode: 3 })

  const plan1 = youkuAudioFetchPlan(ep1, probedFromEp1)
  const plan2 = youkuAudioFetchPlan(ep2, probedFromEp1)
  const plan3 = youkuAudioFetchPlan(ep3, probedFromEp1)

  expect(plan1.map((p) => p.audioVid)).toEqual(['EP1', 'EP1EN'])
  expect(plan2.map((p) => p.audioVid)).toEqual(['EP2', 'EP2EN'])
  // No language siblings on ep3 → both tracks bind to ep3's own vid (never EP1).
  expect(plan3.map((p) => p.audioVid)).toEqual(['EP3', 'EP3'])
  expect(plan2.every((p) => !p.audioVid.startsWith('EP1'))).toBe(true)
  expect(plan3.every((p) => p.audioVid === 'EP3')).toBe(true)

  // Shared probe array must be cloned/remapped per task — mutating one plan's
  // source must not leak into another episode's bound tracks.
  const bound2 = bindYoukuAudioTracksToTask(probedFromEp1, ep2)
  const bound3 = bindYoukuAudioTracksToTask(probedFromEp1, ep3)
  bound2[0]!.vid = 'MUTATED'
  expect(bound3[0]!.vid).toBe('EP3')
  expect(probedFromEp1[0]!.vid).toBe('EP1')
})

test('trackVid rejects foreign episode probe vids', () => {
  const ep2 = task({ vid: 'EP2', episode: 2, languages: [{ vid: 'EP2EN', lang: '英语' }] })
  expect(trackVid(ep2, 'EP1|cmfa1hd3', 'EP1')).toBe('EP2')
  expect(trackVid(ep2, 'EP2EN|cmfa1hd3', 'EP2EN')).toBe('EP2EN')
  expect(trackVid(ep2, 'EP2|atmos')).toBe('EP2')
})

test('bindYoukuAudioTracksToTask keeps codec and remaps id', () => {
  const bound = bindYoukuAudioTracksToTask(
    [{ id: 'EP1|cmfa4hd5_atmos51', label: '杜比全景声', lang: '普通话', vid: 'EP1' }],
    { vid: 'EP9', languages: [{ vid: 'EP9', lang: '普通话' }] },
  )
  expect(bound).toEqual([{
    id: 'EP9|cmfa4hd5_atmos51|zh',
    label: '杜比全景声',
    lang: '普通话',
    vid: 'EP9',
  }])
})

test('batch audio rebinding preserves the chosen default and codec', () => {
  const selected = [
    { id: 'EP1|cmfa1hd3|zh', label: 'AAC', lang: '普通话', vid: 'EP1', codec: 'AAC', isDefault: false },
    { id: 'EP1MIN|cmfa1hd3|min', label: 'AAC', lang: '闽南', vid: 'EP1MIN', codec: 'AAC', isDefault: true },
  ]
  const bound = bindYoukuAudioTracksToTask(selected, { vid: 'EP2', languages: [{ vid: 'EP2MIN', lang: '闽南' }] })
  expect(bound.map(a => a.vid)).toEqual(['EP2', 'EP2MIN'])
  expect(bound.map(a => a.isDefault)).toEqual([false, true])
  expect(bound.map(a => a.codec)).toEqual(['AAC', 'AAC'])
  expect(selected[1]!.vid).toBe('EP1MIN')
})

test('bindYoukuAudioTracksToTask collapses edition copies of one track and keeps the chosen default', () => {
  const task = { vid: 'XEN', languages: [{ vid: 'XEN', lang: '英语' }, { vid: 'XCN', lang: '普通话' }] }
  const bound = bindYoukuAudioTracksToTask([
    { id: 'XEN|cmfa1hd3|en', label: 'AAC', lang: '英语', vid: 'XEN' },
    { id: 'XCN|cmfa1hd3|en', label: 'AAC', lang: '英语', vid: 'XCN', isDefault: true },
    { id: 'XEN|cmfa1hd3|zh', label: 'AAC', lang: '普通话', vid: 'XEN' },
    { id: 'XCN|cmfa1hd3|zh', label: 'AAC', lang: '普通话', vid: 'XCN' },
  ], task)
  expect(bound.map((t) => [t.id, !!t.isDefault])).toEqual([['XEN|cmfa1hd3|en', true], ['XCN|cmfa1hd3|zh', false]])
})

describe('originalAudioLanguage', () => {
  test('keeps a non-English original locale so a mislabelled eng track can be corrected', () => {
    expect(originalAudioLanguage({ audioTracks: [{ id: 'ja-JP', lang: 'ja-JP' }] } as never)).toBe('ja-JP')
    expect(originalAudioLanguage({ audioTracks: [{ id: 'zh-Hans', lang: 'zh-Hans' }] } as never)).toBe('zh-Hans')
  })

  test('stays empty for English originals and for tasks without audio metadata', () => {
    expect(originalAudioLanguage({ audioTracks: [{ id: 'en-US', lang: 'en-US' }] } as never)).toBe('')
    expect(originalAudioLanguage({ audioTracks: [] } as never)).toBe('')
    expect(originalAudioLanguage({} as never)).toBe('')
  })
})

describe('MEDIA_PROBE_PROVIDERS', () => {
  test('covers the providers whose downloads page needs a probed spec line', () => {
    for (const provider of ['mgtv', 'iq', 'iqcn', 'youku', 'bilibili', 'migu', 'crunchyroll', 'appletvplus', 'dsnp']) {
      expect(MEDIA_PROBE_PROVIDERS).toContain(provider)
    }
  })
})

describe('shouldMarkSubtitleFlags', () => {
  const sub = (over: Partial<{ forced: boolean; isDefault: boolean }> = {}) =>
    ({ id: 'en', label: 'English', lang: 'en-US', forced: false, sdh: false, isDefault: false, ...over })

  test('apple tv+ always writes names and default, even without forced/default picks', () => {
    expect(shouldMarkSubtitleFlags('appletvplus', [sub()])).toBe(true)
    expect(shouldMarkSubtitleFlags('appletvplus', [sub({ forced: true })])).toBe(true)
  })

  test('disney+ keeps its original narrow trigger', () => {
    expect(shouldMarkSubtitleFlags('dsnp', [sub()])).toBe(false)
    expect(shouldMarkSubtitleFlags('dsnp', [sub({ isDefault: true })])).toBe(true)
    expect(shouldMarkSubtitleFlags('dsnp', [sub({ forced: true })])).toBe(true)
  })

  test('other providers and empty selections do nothing', () => {
    expect(shouldMarkSubtitleFlags('crunchyroll', [sub()])).toBe(false)
    expect(shouldMarkSubtitleFlags('appletvplus', [])).toBe(false)
    expect(shouldMarkSubtitleFlags('appletvplus', undefined)).toBe(false)
  })
})
