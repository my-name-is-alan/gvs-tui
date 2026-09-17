// Verify multi-track muxing: build a tiny video + two audio tracks, mux them the
// way dlYouku does, then inspect it with bundled mkvmerge (no extra ffprobe).
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lookFFmpeg } from '../src/lib/ffmpeg.ts'
import { mkvmergeMux } from '../src/lib/mkvmerge.ts'
import { ensureMkvmerge } from '../src/lib/tools.ts'

const ffmpeg = lookFFmpeg('ffmpeg')
if (!ffmpeg) throw new Error('no ffmpeg')

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d: Buffer) => { err += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-300)}`))))
  })
}

function probe(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(mkvmerge, ['-J', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`mkvmerge probe exit ${code}`)))
  })
}

const dir = mkdtempSync(join(tmpdir(), 'gvs-mux-'))
const video = join(dir, 'v.mp4')
const a1 = join(dir, 'a1.m4a')
const a2 = join(dir, 'a2.m4a')
const out = join(dir, 'out.mkv')

await run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video])
await run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:a', 'aac', a1])
await run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4', '-c:a', 'aac', a2])

const mkvmerge = await ensureMkvmerge()
let progress = 0
await mkvmergeMux(mkvmerge, video, [
  { path: a1, title: '国语 AAC', lang: 'chi' },
  { path: a2, title: '原声 DTS', lang: 'jpn' },
], out, () => { progress++ })

const info = await probe(out)
const tracks = (JSON.parse(info) as { tracks: Array<{ type: string; properties: { track_name?: string; language?: string } }> }).tracks
const videos = tracks.filter((t) => t.type === 'video').length
const audios = tracks.filter((t) => t.type === 'audio').length
const tagged = tracks.filter((t) => t.properties.track_name === '国语 AAC' && t.properties.language === 'chi').length === 1 &&
  tracks.filter((t) => t.properties.track_name === '原声 DTS' && t.properties.language === 'jpn').length === 1
console.log(`video=${videos} audio=${audios} tags_ok=${tagged} progress_calls=${progress}`)
console.log(videos === 1 && audios === 2 && tagged ? '✓ 两条音轨都封进去了，且带标题/语言' : '✗ 音轨数量或标签不对')

rmSync(dir, { recursive: true, force: true })
process.exit(videos === 1 && audios === 2 && tagged ? 0 : 1)
