import { expect, test } from 'bun:test'
import { audioLabelFromProbe, audioTrackLabel } from './ffmpeg.ts'

test.each([
  ['eac3 (Dolby Digital Plus + Dolby Atmos), 48000 Hz, 5.1(side), fltp', '杜比全景声 5.1'],
  ['eac3, 48000 Hz, stereo, fltp', 'DDP 2.0'],
  ['eac3, 48000 Hz, 5.1(side), fltp', 'DDP 5.1'],
  ['dts (dca) (DTS), 48000 Hz, 5.1(side), fltp', 'DTS 5.1'],
  ['dts (DTS-HD MA + DTS:X), 48000 Hz, 7.1, s32p', 'DTS:X 7.1'],
  ['dts (DTS-HD MA), 48000 Hz, 7.1, s32p', 'DTS-HD MA 7.1'],
  ['aac (LC), 48000 Hz, stereo, fltp', 'AAC 2.0'],
  ['ac3, 48000 Hz, mono, fltp', 'Dolby Digital 1.0'],
  ['eac3, 48000 Hz, fltp', 'DDP'],
  ['none, 48000 Hz, 6 channels', '音轨（编码未确认）'],
])('probe %s', (description, expected) => {
  expect(audioLabelFromProbe(`  Stream #0:0(eng): Audio: ${description}\n    title: Atmos DTS:X`)).toBe(expected)
})

test('does not interpret metadata or a video stream as audio evidence', () => {
  expect(audioLabelFromProbe('Stream #0:0: Video: h264\n title: Audio: eac3 (Atmos)')).toBe('音轨（编码未确认）')
})

test('missing probe tool returns an honest fallback', async () => {
  expect(await audioTrackLabel('nonexistent-gvs-ffmpeg-test', 'missing.mp4')).toBe('音轨（编码未确认）')
})
