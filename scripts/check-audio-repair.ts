// Offline integration: real containers, positive/zero/negative delay and truncation.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ensureFFmpeg, ensureMkvmerge } from '../src/lib/tools.ts'
import { mkvmergeMux } from '../src/lib/mkvmerge.ts'
import { inspectMediaTiming } from '../src/lib/media-timing.ts'
import { validateAudio } from '../src/lib/ffmpeg.ts'

const dir = mkdtempSync(join(tmpdir(), 'gvs repair test '))
const run = (bin: string, args: string[], success = true) => new Promise<void>((resolve, reject) => {
  const p = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', b => { out += b })
  p.stderr.on('data', b => { out += b })
  p.once('error', reject)
  p.once('close', code => (code === 0) === success ? resolve() : reject(new Error(out)))
})
const ffmpeg = await ensureFFmpeg(), mkvmerge = await ensureMkvmerge()
const video = join(dir, 'video.mp4'), audio = join(dir, 'audio.m4a'), input = join(dir, 'input file.mkv')
await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=4', '-c:v', 'libx264', video])
await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=4', '-c:a', 'aac', audio])
await mkvmergeMux(mkvmerge, video, [{ path: audio, title: '音轨1', lang: 'chi' }, { path: audio, title: '音轨2', lang: 'eng' }], input)
const script = resolve(import.meta.dir, 'repair-youku-audio.ts')
const before = await inspectMediaTiming(ffmpeg, input)
for (const delay of [2000, 0, -300]) {
  const output = join(dir, `shift ${delay}.mkv`)
  await run(process.execPath, ['run', script, input, '--track-id', '2', '--delay-ms', String(delay), '--output', output])
  const after = await inspectMediaTiming(ffmpeg, output)
  if (after.length !== 3 || Math.abs(after[2]!.endMs - before[2]!.endMs - delay) > 2 || after[0]!.packets !== before[0]!.packets || after[1]!.packets !== before[1]!.packets) {
    throw new Error(`Incorrect track selection or offset: ${delay}`)
  }
  // Existing destinations must never be overwritten.
  await run(process.execPath, ['run', script, input, '--delay-ms', '0', '--output', output], false)
}
const truncated = join(dir, 'truncated.mkv'), bytes = readFileSync(input)
writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)))
await run(process.execPath, ['run', script, truncated, '--delay-ms', '0'], false)
if (existsSync(join(dir, 'truncated.sync-fixed.mkv'))) throw new Error('Truncated input was published')
let rejected = false
try { await validateAudio(ffmpeg, truncated) } catch { rejected = true }
if (!rejected) throw new Error('Audio validation accepted a truncated container')
console.log('PASS: +2000/0/-300ms, selected audio only, video/other audio preserved, existing output protected, truncated input rejected')
console.log(`Fixture: ${dir}`)
