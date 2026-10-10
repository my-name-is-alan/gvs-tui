import { expect, test } from 'bun:test'
import { assertTencentCoverage, assertTencentSpecs, tencentSpecsFromFFmpeg, verifyTencentCoverage, verifyTencentSpecs } from './tencent-output.ts'
import { completedFilename } from './name.ts'
import { probeFinishedMedia } from './gvs-record.ts'
import type { TrackTiming } from './media-timing.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { lookBundledFFmpeg } from './tools.ts'

function track(type: string, seconds: number, firstMs = 0): TrackTiming {
  return { id: type === 'video' ? 0 : 1, type, firstMs, endMs: firstMs + seconds * 1000, packets: 10, maxGapMs: 0, maxOverlapMs: 0 }
}

test('three-minute video plus 46-minute audio fails even without an episode duration', () => {
  expect(() => assertTencentCoverage([track('video', 207.72), track('audio', 2765)])).toThrow('不完整')
  expect(() => assertTencentCoverage([track('video', 206.24)], 2765)).toThrow('不完整')
  expect(() => assertTencentCoverage([track('audio', 2765)])).toThrow('视频轨')
})

test('actual short episodes, packet offsets and small encoder padding are accepted', () => {
  expect(() => assertTencentCoverage([track('video', 200, 90000), track('audio', 201, 89970)], 200)).not.toThrow()
  expect(() => assertTencentCoverage([track('video', 2765), track('audio', 2765.032)], 2765)).not.toThrow()
})

test('1080p/25fps video cannot satisfy selected 4K/60fps/HDR specs', () => {
  const specs = tencentSpecsFromFFmpeg('  Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, bt709), 1920x1080, 25 fps, 25 tbr')
  expect(specs).toEqual({ width: 1920, height: 1080, fps: 25, hdr: false })
  expect(() => assertTencentSpecs(specs, { width: 3840, height: 2160, fps: 60, hdr: 'hdr' })).toThrow('画质不符')
  expect(() => assertTencentSpecs({ width: 3840, height: 1608, fps: 60, hdr: true }, { width: 3840, height: 1608, fps: 60, hdr: 'hdr' })).not.toThrow()
  expect(() => assertTencentSpecs({ width: 3840, height: 1608, fps: 25, hdr: false }, {}, 2160)).not.toThrow()
})

test('portrait 10-bit BT.709 video remains SDR and catalog HDR becomes a completion warning', () => {
  const specs = tencentSpecsFromFFmpeg('  Stream #0:0[0x100]: Video: hevc (Main 10) ([36][0][0][0] / 0x0024), yuv420p10le(tv, bt709), 2160x3840 [SAR 1:1 DAR 9:16], 60 fps, 60 tbr, 90k tbn, start 0.050000')
  expect(specs).toEqual({ width: 2160, height: 3840, fps: 60, hdr: false })
  expect(() => assertTencentSpecs(specs, { width: 3840, height: 2160, fps: 60, hdr: 'sdr' })).not.toThrow()
  expect(assertTencentSpecs(specs, { width: 2160, height: 3840, fps: 60, hdr: 'hdr' })).toContain('所选 HDR 未在实际视频中确认')
})

test('4K60 SDR is retained with a warning while missing specifications still fail', () => {
  const actual = { width: 3840, height: 1604, fps: 60, hdr: false }
  expect(assertTencentSpecs(actual, { width: 3840, height: 1604, fps: 60, hdr: 'hdr' })).toContain('已保留下载结果')
  expect(assertTencentSpecs({ ...actual, hdr: true }, { hdr: 'hdr' })).toBe('')
  expect(assertTencentSpecs(actual, { hdr: 'sdr' })).toBe('')
  expect(assertTencentSpecs(actual, {})).toBe('')
  expect(() => assertTencentSpecs(null, { hdr: 'hdr' })).toThrow('无法确认')
})

test('landscape batch specs accept the portrait 4K/25fps shopping clips', () => {
  const portrait = { width: 2160, height: 3840, fps: 25, hdr: false }
  expect(() => assertTencentSpecs(portrait, { width: 3840, height: 2160, fps: 25, hdr: 'sdr' })).not.toThrow()
  expect(() => assertTencentSpecs(portrait, { width: 2160, height: 3840, fps: 25, hdr: 'sdr' })).not.toThrow()
  expect(() => assertTencentSpecs({ ...portrait, width: 3840, height: 2160 }, { width: 2160, height: 3840 })).not.toThrow()
  expect(() => assertTencentSpecs(portrait, {}, 2160)).not.toThrow()
  expect(() => assertTencentSpecs(portrait, { width: 3840 })).not.toThrow()
  expect(() => assertTencentSpecs(portrait, { height: 2160 })).not.toThrow()
  expect(() => assertTencentSpecs({ ...portrait, width: 1608 }, { width: 3840, height: 1608 })).not.toThrow()
})

test('ordered edges still reject lower resolution, missing short-edge pixels and lower fps', () => {
  const selected = { width: 3840, height: 2160, fps: 60, hdr: 'sdr' }
  for (const [width, height] of [[1920, 1080], [1080, 1920], [4320, 1920]]) {
    expect(() => assertTencentSpecs({ width: width!, height: height!, fps: 60, hdr: false }, selected)).toThrow('分辨率实际')
  }
  expect(() => assertTencentSpecs({ width: 1080, height: 1920, fps: 60, hdr: false }, {}, 2160)).toThrow('分辨率实际')
  expect(() => assertTencentSpecs({ width: 2160, height: 3840, fps: 25, hdr: false }, selected)).toThrow('帧率实际 25fps，要求 60fps')
  expect(() => assertTencentSpecs({ width: 2160, height: 3840, fps: 59.94, hdr: false }, selected)).not.toThrow()
  try {
    assertTencentSpecs({ width: 1080, height: 1920, fps: 60, hdr: false }, selected)
  } catch (e) {
    expect(String(e)).not.toContain('HDR 未确认')
  }
})

test('only video PQ, HLG and Dolby Vision signaling confirm HDR', () => {
  for (const transfer of ['smpte2084', 'arib-std-b67']) {
    const text = `  Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/${transfer}), 2160x3840, 59.94 fps`
    const specs = tencentSpecsFromFFmpeg(text)
    expect(specs?.hdr).toBe(true)
    expect(() => assertTencentSpecs(specs, { width: 3840, height: 2160, fps: 60, hdr: 'hdr' })).not.toThrow()
  }
  const video = '  Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, bt709), 2160x3840, 60 fps'
  expect(tencentSpecsFromFFmpeg(`${video}\n    Side data:\n      DOVI configuration record: version: 1.0, profile: 8`)?.hdr).toBe(true)
  expect(tencentSpecsFromFFmpeg(`${video}\n    Side data:\n      Dolby Vision configuration record`)?.hdr).toBe(true)
  expect(tencentSpecsFromFFmpeg(`${video}\n    Metadata:\n      title: Dolby Vision smpte2084`)?.hdr).toBe(false)
  expect(tencentSpecsFromFFmpeg(`Input #0 from '/tmp/dolby vision.mkv':\n${video}\n  Stream #0:1: Audio: aac\n    Metadata:\n      title: dovi smpte2084`)?.hdr).toBe(false)
})

test.skipIf(process.env.GVS_MEDIA_TESTS !== '1')('real MKV with longer audio fails packet-based completion', async () => {
  const ffmpeg = lookBundledFFmpeg() || 'ffmpeg'
  const dir = mkdtempSync(join(tmpdir(), 'gvs-tencent-duration-'))
  try {
    const dest = join(dir, 'short-video.mkv')
    execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=32x32:r=25:d=1',
      '-f', 'lavfi', '-i', 'sine=duration=15', '-c:v', 'mpeg4', '-c:a', 'aac', '-y', dest], { windowsHide: true })
    await expect(verifyTencentCoverage(ffmpeg, dest)).rejects.toThrow('不完整')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test.skipIf(process.env.GVS_MEDIA_TESTS !== '1')('real SDR video passes HDR-warning verification and names measured SDR', async () => {
  const ffmpeg = lookBundledFFmpeg() || 'ffmpeg', dir = mkdtempSync(join(tmpdir(), 'gvs-tencent-hdr-warning-'))
  try {
    const path = join(dir, 'sdr.mkv')
    execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=320x240:r=60:d=2',
      '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', '-c:a', 'aac', '-y', path], { windowsHide: true })
    const checked = await verifyTencentSpecs(ffmpeg, path, { width: 320, height: 240, fps: 60, hdr: 'hdr' })
    expect(checked).toMatchObject({ width: 320, height: 240, fps: 60, hdr: false })
    expect(checked.note).toContain('已保留下载结果')
    expect(await verifyTencentCoverage(ffmpeg, path, 2)).toBeGreaterThan(1.9)
    const actual = await probeFinishedMedia(path)
    expect(actual.dynamicRange).toBe('SDR')
    const name = completedFilename({ kind: 'show', title: '节目', nameDots: '', year: 2026, season: 1, episode: 1,
      height: 2160, codec: 'HEVC', tmdbId: 0, source: 'TX', group: 'WF', container: 'mkv' }, actual, 'MAXPLUS')
    expect(name).toContain('.WEB-DL.MAXPLUS.60fps.AVC.AAC.')
    expect(name).not.toContain('.HDR.')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
