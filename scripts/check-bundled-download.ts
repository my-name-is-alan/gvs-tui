// Offline regression: our own CBCS HLS, dead key URI, redirect and clear audio.
import { mkdtempSync, readFileSync, writeFileSync, statSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { ensureFFmpeg, ensurePackager, ensureMkvmerge } from '../src/lib/tools.ts'
import { downloadPlaylist } from '../src/lib/media.ts'
import { mkvmergeMux } from '../src/lib/mkvmerge.ts'
import { cleanupTemporaryFiles } from '../src/lib/jobs.ts'

const dir = mkdtempSync(join(tmpdir(), 'gvs-bundled-check-'))
const run = (bin: string, args: string[]) => new Promise<void>((resolve, reject) => {
  const p = spawn(bin, args, { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  p.stdout.on('data', (b) => { output += b })
  p.stderr.on('data', (b) => { output += b })
  p.once('error', reject)
  p.once('close', (code) => code === 0 ? resolve() : reject(new Error(output)))
})
const ffmpeg = await ensureFFmpeg()
const packager = await ensurePackager()
await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10', '-t', '6', '-c:v', 'libx264', '-g', '10', 'source.mp4'])
await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '6', '-c:a', 'aac', 'audio.mp4'])
const key = '0123456789abcdef0123456789abcdef'
const kid = '11111111111111111111111111111111'
await run(packager, [
  'in=source.mp4,stream=video,init_segment=init.mp4,segment_template=video-$Number$.m4s,playlist_name=video.m3u8',
  '--enable_raw_key_encryption', '--keys', `label=:key_id=${kid}:key=${key}`,
  '--protection_scheme', 'cbcs', '--clear_lead', '0', '--segment_duration', '1',
  '--hls_master_playlist_output', 'master.m3u8',
])
await run(packager, [
  'in=audio.mp4,stream=audio,init_segment=audio-init.mp4,segment_template=audio-$Number$.m4s,playlist_name=audio.m3u8',
  '--segment_duration', '1', '--hls_master_playlist_output', 'audio-master.m3u8',
])
const withDeadKey = (file: string) => readFileSync(join(dir, file), 'utf8')
  .replace(/^#EXT-X-KEY:.*$/gm, '')
  .replace('#EXTM3U', '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="/missing-key"')
writeFileSync(join(dir, 'video.m3u8'), withDeadKey('video.m3u8'))
writeFileSync(join(dir, 'audio.m3u8'), withDeadKey('audio.m3u8'))
let keyRequests = 0
const server = createServer((req, res) => {
  if (req.url === '/redirect') { res.writeHead(302, { Location: '/video.m3u8' }).end(); return }
  if (req.url === '/missing-key') { keyRequests++; res.writeHead(404).end(); return }
  try { res.end(readFileSync(join(dir, (req.url ?? '/').slice(1)))) }
  catch { res.writeHead(404).end() }
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address() as { port: number }
const base = `http://127.0.0.1:${address.port}`
const originalCwd = process.cwd()
process.chdir(tmpdir())
try {
  const progress: number[] = []
  await downloadPlaylist({ src: `${base}/redirect`, dest: join(dir, 'result.mp4'), ref: '', key: `${kid}:${key}`, select: 'video', cb: (n) => progress.push(n) })
  await downloadPlaylist({ src: `${base}/audio.m3u8`, dest: join(dir, 'result-audio.mp4'), ref: '', clear: true, select: 'audio' })
  await mkvmergeMux(await ensureMkvmerge(), join(dir, 'result.mp4'), [{ path: join(dir, 'result-audio.mp4') }], join(dir, 'result.mkv'))
  await run(ffmpeg, ['-v', 'error', '-xerror', '-i', 'result.mkv', '-f', 'null', '-'])
  if (keyRequests !== 0) throw new Error(`Unexpected key URI requests: ${keyRequests}`)
  if (progress.at(-1) !== 1 || progress.some((n, i) => i > 0 && n < progress[i - 1]!)) throw new Error('Progress regressed or did not complete')
  if (!progress.some((n) => n > 0 && n < 1)) throw new Error('No download row progress was parsed')
  if (readdirSync(dir).some((name) => name.startsWith('.re-'))) throw new Error('Download left segment directories')
  let rejected = false
  try {
    await downloadPlaylist({ src: `${base}/video.m3u8`, dest: join(dir, 'failed.mp4'), ref: '', key: 'invalid' })
  } catch { rejected = true }
  if (!rejected || readdirSync(dir).some((name) => name.startsWith('.re-'))) throw new Error('Failed download left its temporary directory')
  await cleanupTemporaryFiles([join(dir, 'result.mp4'), join(dir, 'result-audio.mp4'), join(dir, 'absent.mp4')])
  if (existsSync(join(dir, 'result.mp4')) || existsSync(join(dir, 'result-audio.mp4')) || !existsSync(join(dir, 'result.mkv'))) {
    throw new Error('Track cleanup did not preserve only the final MKV')
  }
  console.log('PASS: success/failure leave no .re-* directory; intermediate tracks removed; final MKV preserved')
  console.log(`PASS: CBCS → HLS redirect → decrypt + clear audio → MKV → full decode (${statSync(join(dir, 'result.mkv')).size} bytes); key URI requests=0; progress monotonic; cwd-independent tools`)
  console.log(`Fixture: ${dir}`)
} finally {
  process.chdir(originalCwd)
  server.closeAllConnections()
  server.close()
}
