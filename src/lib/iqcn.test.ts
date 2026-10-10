import { expect, test } from 'bun:test'
import { iqcnOptions, iqcnSelection, assertIQCNCoverage } from './iqcn.ts'
import { probeOptions } from './quality.ts'
import type { GwClient } from './client.ts'
import { defaultConfig } from './config.ts'

test('domestic quality keeps source names, exact selectors and returned dimensions', async () => {
  const data = { formats: [
    { id: '600|100|25', name: '帧绮映画 4K', width: 3840, height: 1636, bid: 600, br: 100, fr: 25, codec: 'h265', size: 1000, drm: 5 },
    { id: '500|100|25', bid: 500, br: 100, fr: 25, codec: 'h264', drm: 0 },
  ] }
  const options = iqcnOptions(data)
  expect(options.qualities[0]).toMatchObject({ id: '600|100|25', stream: '600|100|25', label: '帧绮映画 4K', width: 3840, height: 1636 })
  expect(options.qualities[1]!.height).toBe(0)
  expect(iqcnSelection(options.qualities[0]!.stream!)).toEqual({ bid: '600', br: '100', fr: '25' })
  const cli = { invoke: async (p: string, a: string, input: unknown) => {
    expect([p, a, input]).toEqual(['iqcn', 'probe', { tvid: '6334402890585900' }]); return data
  } } as unknown as GwClient
  expect((await probeOptions(cli, defaultConfig(), 'iqcn', '6334402890585900')).qualities).toEqual(iqcnOptions(data, '6334402890585900').qualities)
})

test('domestic selection rejects guessed or incomplete selectors', () => {
  for (const value of ['1080p', '600', '600|100|', '600|-1|25', '600|100|25|', '600|100|25|bad/path', '600|100|25|vid|extra']) {
    expect(() => iqcnSelection(value)).toThrow()
  }
})

test('domestic same-tier renditions preserve explicit vid to avoid ambiguous selection', () => {
  expect(iqcnSelection('600|100|25|abcd1234')).toEqual({ bid: '600', br: '100', fr: '25', vid: 'abcd1234' })
})

test('legacy domestic quality names distinguish EDR from EDR 10bit without assuming HDR', () => {
  const options = iqcnOptions({ formats: [
    { id: '800|200|25|edr', bid: 800, br: 200, fr: 25, dynamic_range_code: 4 },
    { id: '800|200|25|edr10', bid: 800, br: 200, fr: 25, dynamic_range_code: 8 },
    { id: '800|200|25|sdr10', bid: 800, br: 200, fr: 25, dynamic_range_code: 7 },
  ] })
  expect(options.qualities.map(q => q.label)).toEqual([
    '超高清 4K · 高码率 · EDR', '超高清 4K · 高码率 · EDR 10bit', '超高清 4K · 高码率 · SDR 10bit',
  ])
})

test('domestic coverage rejects previews, missing audio and mismatched track durations', () => {
  const track = (type: string, duration: number) => ({ id: type === 'video' ? 0 : 1, type, packets: 100, firstMs: 0, endMs: duration * 1000, maxGapMs: 0, maxOverlapMs: 0 })
  expect(() => assertIQCNCoverage([track('video', 30), track('audio', 30)], 1200)).toThrow('不完整')
  expect(() => assertIQCNCoverage([track('video', 1200)], 1200)).toThrow('音轨')
  expect(() => assertIQCNCoverage([track('video', 1200), track('audio', 30)], 1200)).toThrow('不完整')
  expect(() => assertIQCNCoverage([track('video', 1200), track('audio', 1200)], 1200)).not.toThrow()
})
