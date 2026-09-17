import { expect, test } from 'bun:test'
import { jobTitle, patchJob, type DlTask } from './jobs.ts'
import { youkuAudioPlaylist, youkuVideoPlaylist } from './media.ts'

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
  expect(youkuAudioPlaylist(data, 'atmos')).toBe('https://atmos.m3u8')
})
