import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkvmergeMux, mkvmergeRemux, type MuxAudio } from './mkvmerge.ts'
import { mp4boxMux, readMp4Tracks } from './mp4box.ts'
import { firstPresentationMs } from './media-timing.ts'
import { mainlandAudioLanguage } from './audio-language.ts'

const mediaTest = process.env.GVS_MEDIA_TESTS === '1' ? test : test.skip
const run = (bin: string, args: string[]) => {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 20_000, windowsHide: true })
  if (result.status !== 0) throw new Error(`${bin}: ${result.error ?? result.stderr}`)
  return result.stdout
}

mediaTest('MKV and MP4 fill unknown domestic audio only, preserving source languages, defaults, timing and samples', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-audio-language-'))
  try {
    const video = join(dir, 'video.mp4')
    run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=25:d=1', '-c:v', 'libx264', video])
    const audios: MuxAudio[] = ['und', 'eng', 'und', 'und'].map((lang, i) => {
      const path = join(dir, `audio-${i}.mp4`)
      run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${440 + i * 110}:sample_rate=48000:duration=1`,
        '-c:a', 'aac', '-metadata:s:a:0', `language=${lang}`, path])
      return { path, lang: i === 2 ? '粤语' : i === 3 ? '闽南' : '原声', title: `audio-${i}`, isDefault: i === 1 }
    })
    for (const container of ['mkv', 'mp4']) {
      const out = join(dir, `output.${container}`)
      const fallback = mainlandAudioLanguage({ id: 1793262, kind: 'movie', countries: [], originalLanguage: 'zh' })
      if (container === 'mkv') await mkvmergeMux('mkvmerge', video, audios, out, undefined, undefined, undefined, fallback)
      else await mp4boxMux('MP4Box', video, audios, out, undefined, undefined, fallback)
      const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', out]))
      expect(probe.streams.slice(1).map((s: { disposition: { default: number } }) => s.disposition.default)).toEqual([1, 0, 0, 0])
      expect(probe.streams.slice(1).map((s: { codec_name: string }) => s.codec_name)).toEqual(['aac', 'aac', 'aac', 'aac'])
      if (container === 'mkv') {
        const tracks = JSON.parse(run('mkvmerge', ['-J', out])).tracks
        expect(tracks[0].properties.language).toBe('und')
        // MKV's legacy ISO 639-2 field groups Chinese dialects under chi;
        // the IETF field retains their specific language codes.
        expect(tracks.slice(1).map((t: { properties: { language_ietf: string } }) => t.properties.language_ietf)).toEqual(['en', 'zh', 'yue', 'nan'])
      } else {
        expect((await readMp4Tracks('MP4Box', out)).map(t => t.language)).toEqual(['und', 'eng', 'zho', 'yue', 'nan'])
      }
      expect(JSON.parse(readFileSync(`${out}.timing.json`, 'utf8')).verified).toBe(true)
      const videoBefore = await firstPresentationMs('ffmpeg', video, 'v:0')
      const videoAfter = await firstPresentationMs('ffmpeg', out, 'v:0')
      // Compare coded audio samples as well as their starts; adding labels must not transcode.
      for (const [i, sourceIndex] of [1, 0, 2, 3].entries()) {
        const audio = audios[sourceIndex]!
        const hashes = (path: string, stream: string) => JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', stream,
          '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=data_hash', '-of', 'json', path])).packets.map((p: { data_hash: string }) => p.data_hash)
        expect(hashes(out, `a:${i}`)).toEqual(hashes(audio.path, 'a:0'))
        const before = await firstPresentationMs('ffmpeg', audio.path, 'a:0')
        const after = await firstPresentationMs('ffmpeg', out, `a:${i}`)
        expect(Math.abs((before - videoBefore) - (after - videoAfter))).toBeLessThanOrEqual(2)
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 60_000)

mediaTest('embedded-audio MKV remux tags only undefined audio and leaves video/subtitles/foreign audio intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-embedded-language-'))
  try {
    const input = join(dir, 'embedded.mkv'), out = join(dir, 'domestic.mkv'), unchanged = join(dir, 'unmatched.mkv')
    run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=25:d=1',
      '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-c:a', 'aac', '-metadata:s:v:0', 'title=视频说明',
      '-metadata:s:a:0', 'language=und', '-metadata:s:a:0', 'title=普通话 · AAC', '-metadata:s:a:1', 'language=eng', '-metadata:s:a:1', 'title=英语 · AAC', input])
    await mkvmergeRemux('mkvmerge', input, out, undefined, undefined, 'zh')
    let tracks = JSON.parse(run('mkvmerge', ['-J', out])).tracks
    expect(tracks.map((t: { properties: { language: string } }) => t.properties.language)).toEqual(['und', 'chi', 'eng'])
    expect(tracks[1].properties.language_ietf).toBe('zh')
    expect(tracks[0].properties.track_name).toBe('视频说明')
    expect(tracks.slice(1).every((t: { properties: { track_name?: string } }) => !t.properties.track_name)).toBe(true)
    await mkvmergeRemux('mkvmerge', input, unchanged)
    tracks = JSON.parse(run('mkvmerge', ['-J', unchanged])).tracks
    expect(tracks.map((t: { properties: { language: string } }) => t.properties.language)).toEqual(['und', 'und', 'eng'])
    expect(tracks[0].properties.track_name).toBe('视频说明')
    expect(tracks.slice(1).every((t: { properties: { track_name?: string } }) => !t.properties.track_name)).toBe(true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 60_000)
