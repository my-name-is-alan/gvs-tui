import { expect, test } from 'bun:test'
import { assertAudioContinuity, assertMediaDuration, frameCrcTiming, relativePresentationStarts } from './media-timing.ts'

test('one shared origin preserves positive, negative and multi-audio relative starts', () => {
  expect(relativePresentationStarts(0, [2500], [0])).toEqual([0, 2500])
  expect(relativePresentationStarts(8000, [10500, 7000], [0, 0])).toEqual([1000, 3500, 0])
  expect(relativePresentationStarts(8000, [10500], [-500])).toEqual([0, 2000])
  expect(relativePresentationStarts(0, [-23.22], [0])).toEqual([23.22, 0])
  expect(() => relativePresentationStarts(NaN, [0], [0])).toThrow()
})

test('packet timing uses PTS and supports split lines, B frames and multiple tracks', () => {
  const parser = frameCrcTiming()
  parser.feed('#tb 0: 1/60\n#media_type 0: video\n#tb 1: 1/48000\n#media_type 1: audio\n0, -3, 0, 1, 1, 0x1\n0, -2, 8, 1, 1, 0x2\n0, -1, 4, 1, 1, 0x3\n1, 96000, 960')
  parser.feed('00, 1024, 1, 0x4\r\n1, 97024, 97024, 1024, 1, 0x5')
  const tracks = parser.finish()
  expect(tracks[0]!.firstMs).toBe(0)
  expect(tracks[0]!.endMs).toBe(150)
  expect(tracks[1]!.firstMs).toBe(2000)
  expect(tracks[1]!.packets).toBe(2)
  expect(() => assertAudioContinuity(tracks)).not.toThrow()
})

test('a valid container duration cannot hide truncated media', () => {
  const parser = frameCrcTiming()
  parser.feed('#tb 0: 1/1000\n#media_type 0: audio\n0, 0, 0, 453602, 1, 0x1\n')
  const tracks = parser.finish()
  expect(() => assertMediaDuration(tracks, 3211366)).toThrow('预期')
  expect(() => assertMediaDuration(tracks, NaN)).toThrow()
})

test('internal audio gaps and resets cannot be corrected with a constant delay', () => {
  for (const pts of [2000, 0]) {
    const parser = frameCrcTiming()
    parser.feed(`#tb 0: 1/1000\n#media_type 0: audio\n0, 0, 0, 1000, 1, 0x1\n0, ${pts}, ${pts}, 1000, 1, 0x2\n`)
    expect(() => assertAudioContinuity(parser.finish())).toThrow('不连续')
  }
})
