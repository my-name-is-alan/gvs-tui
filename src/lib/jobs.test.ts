import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobHub, cleanupOutputCaches, jobTitle, patchJob, youkuDRM, type DlTask } from './jobs.ts'
import { youkuAudioPlaylist, youkuUsesSeparateAudio, youkuVideoPlaylist } from './media.ts'
import type { FileConfig } from './config.ts'
import type { GwClient } from './client.ts'

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

test('audio 0:0 is full-block CBC and must be decrypted', () => {
  const drm = youkuDRM({ drm: { need_decrypt: true, pattern_audio: '0:0', content_key_hex: 'a'.repeat(32) } })
  expect(drm.audioEnc).toBe(true)
  expect(drm.reKey).toBe('a'.repeat(32))
  expect(youkuDRM({ drm: { actually_clear: true } }).audioEnc).toBe(false)
  expect(youkuDRM({ drm: { need_decrypt: false } }).videoEnc).toBe(false)
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
  expect(jobTitle(task({}))).toBe('第九区 E01 4K')
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


test('youku separate audio only for 帧享 HQ cmfv with playlist', () => {
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
  expect(youkuUsesSeparateAudio(tv, 'hls5hd4_sdr_hfr_hbr_bit10_hq')).toBe(false)

  // selecting HLS quality on a response that still advertises separate delivery
  expect(youkuUsesSeparateAudio({ ...hq, audio_delivery: 'separate' }, 'hls5hd3')).toBe(false)

  const invOnly = {
    video: { stream_type: 'cmfv5hd4_sdr_hfr_hbr_bit10_hq' },
    audio_tracks: [{ stream_type: 'cmfa1hd3' }],
  }
  expect(youkuUsesSeparateAudio(invOnly, 'cmfv5hd4_sdr_hfr_hbr_bit10_hq')).toBe(false)
})
