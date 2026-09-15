// Verify multi-track muxing: build a tiny video + two audio tracks, mux them the
// way dlYouku does, then ffprobe the result and assert the streams and tags.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffmpegMux, lookFFmpeg } from '../src/lib/ffmpeg.ts'

const ffmpeg = lookFFmpeg('ffmpeg')
if (!ffmpeg) throw new Error('no ffmpeg')
const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'))

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
    const child = spawn(ffprobe, ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name:stream_tags=title,language', '-of', 'csv=p=0', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    child.on('error', reject)
    child.on('close', () => resolve(out.trim()))
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

let progress = 0
await ffmpegMux(ffmpeg, video, [
  { path: a1, title: '国语 AAC', lang: 'chi' },
  { path: a2, title: '原声 DTS', lang: 'jpn' },
], out, () => { progress++ })

const info = await probe(out)
console.log('--- streams ---')
console.log(info)
const lines = info.split('\n').filter(Boolean)
const videos = lines.filter((l) => l.includes('video')).length
const audios = lines.filter((l) => l.includes('audio')).length
const tagged = lines.filter((l) => l.includes('国语 AAC') && l.includes('chi')).length === 1 &&
  lines.filter((l) => l.includes('原声 DTS') && l.includes('jpn')).length === 1
console.log(`video=${videos} audio=${audios} tags_ok=${tagged} progress_calls=${progress}`)
console.log(videos === 1 && audios === 2 && tagged ? '✓ 两条音轨都封进去了，且带标题/语言' : '✗ 音轨数量或标签不对')

rmSync(dir, { recursive: true, force: true })
process.exit(videos === 1 && audios === 2 && tagged ? 0 : 1)
