// Verify that the ffmpeg phase watcher reports movement, using a real large file
// from the download dir (copied to temp, never modified).
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffmpegRemux, lookFFmpeg } from '../src/lib/ffmpeg.ts'

const ffmpeg = lookFFmpeg('ffmpeg')
if (!ffmpeg) throw new Error('no ffmpeg')

const dir = mkdtempSync(join(tmpdir(), 'gvs-ff-'))
const src = join(dir, 'in.mp4')
const out = join(dir, 'out.mkv')

const real = 'downloads/边水往事/Season 01/.XNjQyMTA3MzQ4MA==.audio.mp4'
if (existsSync(real)) {
  copyFileSync(real, src)
} else {
  writeFileSync(src, Buffer.alloc(120 * 1024 * 1024, 7))
  console.log('(filler input - sampling mechanism only)')
}
console.log(`input: ${(statSync(src).size / 1048576).toFixed(1)} MB`)

const samples: string[] = []
const started = Date.now()
await ffmpegRemux(ffmpeg, src, out, (n, total) => {
  samples.push(`${String(Date.now() - started).padStart(5)}ms  ${(n / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB  ${((n / total) * 100).toFixed(0)}%`)
})
console.log(`samples: ${samples.length}`)
for (const line of samples.slice(0, 3)) console.log(`  ${line}`)
if (samples.length > 4) console.log('  ...')
for (const line of samples.slice(-2)) console.log(`  ${line}`)

const grew = samples.length > 1 && samples[0] !== samples[samples.length - 1]
console.log(grew ? 'OK progress callback moves' : 'FAIL no progress callback')
rmSync(dir, { recursive: true, force: true })
process.exit(grew ? 0 : 1)
