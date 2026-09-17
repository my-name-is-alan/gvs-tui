// Integration regression: real MP4/MKV readers, edit lists, B frames and AAC.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureFFmpeg, ensureMkvmerge } from '../src/lib/tools.ts'
import { mkvmergeMux, mkvmergeMuxArgs } from '../src/lib/mkvmerge.ts'
import { ffmpegMux } from '../src/lib/ffmpeg.ts'
import { firstPresentationMs, relativePresentationStarts } from '../src/lib/media-timing.ts'

const dir = mkdtempSync(join(tmpdir(), 'gvs mux sync '))
const ffmpeg = await ensureFFmpeg(), mkvmerge = await ensureMkvmerge()
async function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', b => { out += b })
    p.stderr.on('data', b => { err += b })
    p.once('error', reject)
    p.once('close', c => c === 0 ? resolve(out) : reject(new Error(err || out)))
  })
}
async function packets(path: string, stream: string) {
  const result = await run(ffmpeg, ['-nostdin', '-v', 'error', '-copyts', '-i', path, '-map', `0:${stream}`,
    '-c', 'copy', '-avoid_negative_ts', 'disabled', '-f', 'framecrc', 'pipe:1'])
  const tb = /#tb 0: (\d+)\/(\d+)/.exec(result)!
  const scale = Number(tb[1]) / Number(tb[2]) * 1000
  return result.split('\n').filter(l => /^0,/.test(l)).map(l => {
    const fields = l.split(',')
    return { pts: Number(fields[2]) * scale, size: Number(fields[4]), crc: fields[5]!.trim() }
  })
}
async function video(name: string, start: number, fragmented = false) {
  const path = join(dir, name)
  await run(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=1',
    '-c:v', 'libx264', '-bf', '2', '-output_ts_offset', String(start),
    ...(fragmented ? ['-movflags', 'empty_moov+frag_keyframe+default_base_moof'] : []), path])
  return path
}
async function audio(name: string, start: number, fragmented = false) {
  const path = join(dir, name)
  await run(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'aac',
    '-output_ts_offset', String(start + 1024 / 44100),
    ...(fragmented ? ['-movflags', 'empty_moov+frag_keyframe+default_base_moof'] : []), path])
  return path
}
const v0 = await video('v0.mp4', 0), a25 = await audio('a25.mp4', 2.5)
const sourceStart = await firstPresentationMs(ffmpeg, a25, 'a:0')
if (Math.abs(sourceStart - 2500) > 1) throw new Error(`Invalid reproduction: ${sourceStart}`)
const broken = join(dir, 'unadjusted.mkv')
await run(mkvmerge, mkvmergeMuxArgs(broken, v0, [{ path: a25 }]))
const brokenStart = await firstPresentationMs(ffmpeg, broken, 'a:0')
if (Math.abs(brokenStart) > 1) throw new Error(`Expected old MP4 normalization, got ${brokenStart}`)
console.log('REPRODUCED: source audio 2500ms → unadjusted mux 0ms')

async function verify(label: string, v: string, audios: Array<{ path: string; delayMs?: number }>, useFFmpeg = false) {
  const output = join(dir, `${label}.mkv`)
  const source = [await packets(v, 'v:0')]
  for (const a of audios) source.push(await packets(a.path, 'a:0'))
  const sourceStarts = source.map(p => Math.min(...p.map(x => x.pts)))
  const expected = relativePresentationStarts(sourceStarts[0]!, sourceStarts.slice(1), audios.map(a => a.delayMs ?? 0))
  if (useFFmpeg) await ffmpegMux(ffmpeg, v, audios, output)
  else await mkvmergeMux(mkvmerge, v, audios, output)
  const actual = [await packets(output, 'v:0')]
  for (let i = 0; i < audios.length; i++) actual.push(await packets(output, `a:${i}`))
  const starts = actual.map(p => Math.min(...p.map(x => x.pts)))
  const commonShift = starts[0]! - expected[0]!
  for (let i = 0; i < source.length; i++) {
    if (Math.abs((starts[i]! - starts[0]!) - (expected[i]! - expected[0]!)) > 2) throw new Error(`${label}: relative start lost`)
    if (source[i]!.length !== actual[i]!.length) throw new Error(`${label}: packets dropped`)
    source[i]!.forEach((p, j) => {
      const q = actual[i]![j]!
      if (q.size !== p.size || q.crc !== p.crc) throw new Error(`${label}: packet data changed`)
      const targetPts = p.pts - sourceStarts[i]! + expected[i]! + commonShift
      if (Math.abs(q.pts - targetPts) > 2) throw new Error(`${label}: packet timestamp drift`)
    })
  }
  if (!useFFmpeg && !JSON.parse(readFileSync(`${output}.timing.json`, 'utf8')).verified) throw new Error('Missing timing evidence')
  console.log(`PASS ${label}: starts=${starts.map(n => n.toFixed(3)).join(',')}ms; all packet payloads/order/PTS verified`)
  return output
}
await verify('audio-2500', v0, [{ path: a25 }])
await verify('explicit-zero', v0, [{ path: a25, delayMs: 0 }])
const v8 = await video('v8.mp4', 8), a105 = await audio('a105.mp4', 10.5), a7 = await audio('a7.mp4', 7)
await verify('shared-origin-multiple-tracks', v8, [{ path: a105 }, { path: a7 }])
await verify('negative-extra-adjustment', v8, [{ path: a105, delayMs: -500 }])
const fv = await video('fv.mp4', 4, true), fa = await audio('fa.mp4', 6.5, true)
// FFmpeg starts generated empty_moov fragments at zero despite output offset.
// Set the decode origin in this controlled single-track fixture, then verify
// the resulting *presentation* time through the actual demuxer.
const fragment = readFileSync(fa)
const tfdt = fragment.indexOf(Buffer.from('tfdt')), mdhd = fragment.indexOf(Buffer.from('mdhd'))
const timescale = fragment.readUInt32BE(mdhd + 16)
if (fragment[tfdt + 4] === 1) fragment.writeBigUInt64BE(BigInt(Math.round(2.5 * timescale)), tfdt + 8)
else fragment.writeUInt32BE(Math.round(2.5 * timescale), tfdt + 8)
writeFileSync(fa, fragment)
await verify('fragmented-mp4', fv, [{ path: fa }])
const amka = join(dir, 'already-offset.mka')
await run(mkvmerge, ['-o', amka, '--sync', '0:2500', a25])
await verify('mka-offset-not-doubled', v0, [{ path: amka }])
await verify('ffmpeg-cross-file-offset', v0, [{ path: a25 }], true)
console.log(`Fixture: ${dir}`)
