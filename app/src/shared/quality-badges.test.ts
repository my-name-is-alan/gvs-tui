import { expect, test } from 'bun:test'
import { badgesFromQualities, badgesFromText, HintQueue, mergeHints, qualityScore } from './quality-badges'

test('badges from search meta text', () => {
  expect(badgesFromText('庆余年 4K 杜比视界', '全景声').badges).toEqual(['4K', 'DV', 'ATMOS'])
  expect(badgesFromText('1080P HDR', '杜比音效').badges).toEqual(['1080P', 'HDR', 'DOLBY'])
  expect(badgesFromText('杜比视界版').badges).toEqual(['DV'])
  expect(badgesFromText('2026 · 剧情 · 全 40 集').source).toBe('none')
  expect(badgesFromText('IMAX 60帧').badges).toEqual(['IMAX', '60FPS'])
})

test('badges from probed qualities', () => {
  const h = badgesFromQualities([
    { height: 2160, hdr: 'dolbyvision', fps: 60 },
    { height: 1080, hdr: 'sdr', audios: [{ label: '杜比全景声', codec: 'E-AC-3' }] },
  ], [], 5)
  expect([h.badges, h.height, h.source, h.at]).toEqual([['4K', 'DV', 'ATMOS', '60FPS'], 2160, 'probe', 5])
  expect(badgesFromQualities([{ height: 1080, hdr: 'HDR10' }], [{ label: 'AAC', codec: 'mp4a' }]).badges).toEqual(['1080P', 'HDR'])
})

test('merge and score order results', () => {
  const m = mergeHints(badgesFromText('杜比'), badgesFromQualities([{ height: 2160, hdr: '' }]))
  expect(m.badges).toEqual(['4K', 'DOLBY'])
  expect(qualityScore(badgesFromText('4K')) > qualityScore(badgesFromText('1080P HDR 杜比'))).toBe(true)
  expect(qualityScore(badgesFromText('1080P HDR')) > qualityScore(badgesFromText('1080P'))).toBe(true)
  expect(qualityScore(null)).toBe(0)
})

test('HintQueue: concurrency limit, dedupe, cache, timeout aborts work', async () => {
  let now = 0
  let active = 0, peak = 0, calls = 0, aborted = 0
  const started = Promise.withResolvers<void>()
  const q = new HintQueue<string>(async (k, signal) => {
    calls++; active++; peak = Math.max(peak, active)
    if (calls === 2) started.resolve()
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    if (k === 'slow') signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')) }, { once: true })
    else resolve()
    await promise
    active--
    return k.toUpperCase()
  }, { concurrency: 2, timeoutMs: 20, ttlMs: 1000, failTtlMs: 100, now: () => now })
  const pending = Promise.all(['a', 'slow', 'a'].map((k) => q.get(k)))
  await started.promise
  await pending
  expect(peak).toBe(2)
  expect(calls).toBe(2)
  expect(aborted).toBe(1)
  expect(q.peek('slow')).toBe(null)
  expect(await q.get('a')).toBe('A')
  expect(calls).toBe(2)
  now = 200
  expect(q.peek('slow')).toBeUndefined()
})
