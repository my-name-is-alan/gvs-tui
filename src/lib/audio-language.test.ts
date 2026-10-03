import { expect, test } from 'bun:test'
import { mainlandAudioLanguage, prepareAudioLanguage, resolveAudioLanguage } from './audio-language.ts'
import { mkvLang } from './mkvmerge.ts'
import { mp4Lang } from './mp4box.ts'
import type { DlTask } from './jobs.ts'
import type { TmdbDetails } from './tmdb.ts'

const domestic: TmdbDetails = { id: 123, kind: 'movie', countries: ['CN'], originalLanguage: 'zh' }

test('only a matched mainland production enables the Chinese fallback', () => {
  expect(mainlandAudioLanguage(domestic)).toBe('zh')
  expect(mainlandAudioLanguage({ ...domestic, kind: 'show' })).toBe('zh')
  expect(mainlandAudioLanguage({ ...domestic, originalLanguage: '' })).toBe('zh')
  expect(mainlandAudioLanguage({ ...domestic, countries: ['CN', 'HK'] })).toBe('zh')
  for (const countries of [[], ['US'], ['JP'], ['HK'], ['TW']]) {
    expect(mainlandAudioLanguage({ ...domestic, countries })).toBe('')
  }
  expect(mainlandAudioLanguage({ ...domestic, countries: ['CN', 'US'], originalLanguage: 'en' })).toBe('')
  expect(mainlandAudioLanguage()).toBe('')
})

test('fallback fills unknown audio languages while retaining explicit and source languages', () => {
  for (const unknown of ['', '原声', 'und', '未知', '—', 'AAC', 'DTS']) {
    expect(resolveAudioLanguage(unknown, 'und', 'zh')).toBe('zh')
    expect(resolveAudioLanguage(unknown, 'eng', 'zh')).toBe('eng')
    expect(resolveAudioLanguage(unknown, 'und')).toBe('und')
  }
  for (const explicit of ['普通话', '粤语', '闽南', 'eng', 'ja', 'en-GB', 'yue']) {
    expect(resolveAudioLanguage(explicit, 'und', 'zh')).toBe(explicit)
  }
  expect(mkvLang(resolveAudioLanguage('原声', '', 'zh'))).toBe('chi')
  expect(mp4Lang(resolveAudioLanguage('原声', '', 'zh'))).toBe('zho')
  expect(mkvLang('en-GB')).toBe('eng')
  expect(mkvLang('闽南')).toBe('nan')
})

test('job retains matched metadata for offline resume and never changes audio selection', async () => {
  const task = { tmdbId: 123, kind: 'movie', audioTracks: [{ id: 'original', label: 'DTS', lang: '原声', isDefault: true }] } as DlTask
  let calls = 0
  const lookup = async (_key: string, kind: string, id: number, options: { proxy?: string } = {}) => {
    calls++
    expect([kind, id, options.proxy]).toEqual(['movie', 123, 'http://127.0.0.1:7897'])
    return domestic
  }
  expect(await prepareAudioLanguage({ tmdbKey: 'key', tmdbProxy: 'http://127.0.0.1:7897' }, task, undefined, lookup)).toBe('zh')
  expect(task.tmdbMetadata).toEqual(domestic)
  expect(await prepareAudioLanguage({ tmdbKey: '' }, task, undefined, lookup)).toBe('zh')
  expect(calls).toBe(1)
  expect(task.audioTracks).toEqual([{ id: 'original', label: 'DTS', lang: '原声', isDefault: true }])
})

test('skipping or changing TMDB match cannot reuse stale domestic metadata', async () => {
  const cfg = { tmdbKey: 'key' }
  const task = { tmdbId: 0, kind: 'movie', tmdbMetadata: domestic } as DlTask
  let calls = 0
  const lookup = async () => { calls++; return { ...domestic, id: 999, countries: ['US'], originalLanguage: 'en' } }
  expect(await prepareAudioLanguage(cfg, task, undefined, lookup)).toBe('')
  expect(calls).toBe(0)
  task.tmdbId = 999
  expect(await prepareAudioLanguage(cfg, task, undefined, lookup)).toBe('')
  expect(task.tmdbMetadata?.id).toBe(999)
  expect(calls).toBe(1)
})

test('missing keys and aborted/failed lookups never save guessed metadata', async () => {
  const task = { tmdbId: 123, kind: 'movie' } as DlTask
  let calls = 0
  const lookup = async () => { calls++; throw new Error('TMDB unavailable') }
  expect(await prepareAudioLanguage({ tmdbKey: '' }, task, undefined, lookup)).toBe('')
  const ctrl = new AbortController(); ctrl.abort(new Error('paused'))
  await expect(prepareAudioLanguage({ tmdbKey: 'key' }, task, ctrl.signal, lookup)).rejects.toThrow('paused')
  expect(calls).toBe(0)
  await expect(prepareAudioLanguage({ tmdbKey: 'key' }, task, undefined, lookup)).rejects.toThrow('TMDB unavailable')
  expect(task.tmdbMetadata).toBeUndefined()
})
