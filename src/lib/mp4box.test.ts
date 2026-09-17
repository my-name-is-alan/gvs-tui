import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { isDtsAudio, inspectMp4, mp4boxMux, mp4Lang, presentationMs, type Mp4Track } from './mp4box.ts'
import { firstPresentationMs } from './media-timing.ts'

test('DTS selection and MP4 language codes', () => {
  expect(isDtsAudio({ id: 'cmfa3hd5_dtsc51' })).toBe(true)
  expect(isDtsAudio({ label: 'DTS:X' })).toBe(true)
  expect(isDtsAudio({ codec: 'dtsy' })).toBe(true)
  expect(isDtsAudio({ id: 'cmfa4hd4_51', label: '杜比全景声' })).toBe(false)
  expect(mp4Lang('普通话')).toBe('zho')
  expect(mp4Lang('DTS')).toBe('und')
})

test('presentation time includes edit trim and empty edit, not just tfdt', () => {
  const track: Mp4Track = { id: 1, type: 'vide', codec: 'hvc1', scale: 60, movieScale: 1000,
    edits: [{ duration: 2000, mediaTime: -1 }, { duration: 0, mediaTime: 3 }], language: 'und', name: '', duration: 600 }
  expect(presentationMs(track, 3)).toBe(2000)
  expect(presentationMs(track, 479)).toBeCloseTo(9933.333333, 3)
})

// Real binaries exercise edit lists, sample preservation and the codec-independent
// inspection path. Linux CI has no bundled executables; Windows CI runs this.
const mediaTest = process.platform === 'win32' && process.arch === 'x64' ? test : test.skip
mediaTest('MP4Box preserves positive and negative relative offsets and multi-audio payloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-mp4box-test-'))
  const ff = resolve('bin/ffmpeg.exe'), box = resolve('bin/MP4Box.exe')
  const generate = (args: string[]) => {
    const p = spawnSync(ff, ['-nostdin', '-v', 'error', '-y', ...args], { windowsHide: true, encoding: 'utf8' })
    if (p.status !== 0) throw new Error(p.stderr)
  }
  try {
    const video = join(dir, 'video.mp4'), late = join(dir, 'late.mp4'), early = join(dir, 'early.mp4')
    generate(['-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=25:d=2', '-c:v', 'libx264', '-bf', '2', '-output_ts_offset', '1', video])
    generate(['-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=2', '-c:a', 'aac', '-output_ts_offset', '3.5', late])
    generate(['-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=2', '-c:a', 'aac', early])
    const out = join(dir, 'multi.mp4')
    await mp4boxMux(box, video, [{ path: late, title: 'DTS:X', lang: '普通话' }, { path: early, title: 'AAC', lang: 'eng' }], out)
    const report = JSON.parse(readFileSync(`${out}.timing.json`, 'utf8'))
    expect(report.verified).toBe(true)
    const tracks = await inspectMp4(box, out)
    expect(tracks.map(t => t.language)).toEqual(['und', 'zho', 'eng'])
    expect(tracks.slice(1).map(t => t.name)).toEqual(['DTS:X', 'AAC'])
    for (const [i, path] of [video, late, early].entries()) {
      const type = i ? 'a:0' : 'v:0', stream = i ? `a:${i - 1}` : 'v:0'
      const before = await firstPresentationMs(ff, path, type)
      const after = await firstPresentationMs(ff, out, stream)
      expect(Math.abs(before - after)).toBeLessThanOrEqual(2)
    }
    // Truncated media must fail even if MP4Box still returns its sample table.
    truncateSync(out, statSync(out).size - 500)
    await expect(inspectMp4(box, out)).rejects.toThrow()
    const fragmented = join(dir, 'fragmented.mp4')
    generate(['-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=2', '-c:a', 'aac',
      '-movflags', 'empty_moov+frag_keyframe+default_base_moof', fragmented])
    const bytes = readFileSync(fragmented)
    const tfdt = bytes.indexOf('tfdt')
    expect(tfdt).toBeGreaterThan(0)
    if (bytes[tfdt + 4] === 1) bytes.writeBigUInt64BE(120000n, tfdt + 8)
    else bytes.writeUInt32BE(120000, tfdt + 8)
    writeFileSync(fragmented, bytes)
    await mp4boxMux(box, video, [{ path: fragmented }], join(dir, 'fragment-output.mp4'))
    const result = await inspectMp4(box, join(dir, 'fragment-output.mp4'))
    expect(result[1]!.firstMs).toBeCloseTo(2500, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 60000)
