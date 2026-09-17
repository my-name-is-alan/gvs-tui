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
import { validateAudio } from '../src/lib/ffmpeg.ts'
import { assertAudioContinuity, inspectMediaTiming } from '../src/lib/media-timing.ts'

const dir = mkdtempSync(join(tmpdir(), 'gvs-中文 path-'))
const run = (bin: string, args: string[]) => new Promise<string>((resolve, reject) => {
  const p = spawn(bin, args, { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  p.stdout.on('data', (b) => { output += b })
  p.stderr.on('data', (b) => { output += b })
  p.once('error', reject)
  p.once('close', (code) => code === 0 ? resolve(output) : reject(new Error(output)))
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
await run(packager, [
  'in=audio.mp4,stream=audio,init_segment=encrypted-audio-init.mp4,segment_template=encrypted-audio-$Number$.m4s,playlist_name=encrypted-audio.m3u8',
  '--enable_raw_key_encryption', '--keys', `label=:key_id=${kid}:key=${key}`,
  '--protection_scheme', 'cbcs', '--clear_lead', '0', '--segment_duration', '1',
  '--hls_master_playlist_output', 'encrypted-audio-master.m3u8',
])
const withDeadKey = (file: string) => readFileSync(join(dir, file), 'utf8')
  .replace(/^#EXT-X-KEY:.*$/gm, '')
  .replace('#EXTM3U', '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="/missing-key"')
writeFileSync(join(dir, 'video.m3u8'), withDeadKey('video.m3u8'))
writeFileSync(join(dir, 'audio.m3u8'), withDeadKey('audio.m3u8'))
writeFileSync(join(dir, 'encrypted-audio.m3u8'), withDeadKey('encrypted-audio.m3u8'))
let keyRequests = 0
let wrongHeaders = 0
let transientDenied = 0
let refreshCalls = 0
const requestPaths: string[] = []
const server = createServer((req, res) => {
  const requestUrl = new URL(req.url ?? '/', 'http://localhost')
  const path = requestUrl.pathname
  requestPaths.push(req.url ?? '/')
  if (!req.headers['user-agent']?.includes('Chrome/122.0') || req.headers.accept !== '*/*'
    || req.headers['accept-language'] !== 'zh-CN,zh;q=0.9') {
    wrongHeaders++
    res.writeHead(403).end('Expected original JS download headers')
    return
  }
  if (path === '/redirect') { res.writeHead(302, { Location: '/video.m3u8?v=0' }).end(); return }
  if (path === '/missing-key') { keyRequests++; res.writeHead(404).end(); return }
  // The old signed URL NEVER recovers: only refreshing it can make progress.
  if (path === '/video-3.m4s' && Number(requestUrl.searchParams.get('v') ?? 0) < 3) {
    transientDenied++; res.writeHead(403).end('expired URL'); return
  }
  try {
    let bytes = readFileSync(join(dir, path.slice(1)))
    if (path.endsWith('.m3u8')) {
      const version = requestUrl.searchParams.get('v') ?? '0'
      bytes = Buffer.from(bytes.toString().split(/\r?\n/).map(l => l.startsWith('#')
        ? l.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${uri}?v=${version}"`)
        : l.trim() ? `${l}?v=${version}` : l).join('\n'))
    }
    // Give the downloader time to render an intermediate progress update.
    if (path.endsWith('.m4s')) setTimeout(() => res.end(bytes), 180)
    else res.end(bytes)
  }
  catch { res.writeHead(404).end() }
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address() as { port: number }
const base = `http://127.0.0.1:${address.port}`
const originalCwd = process.cwd()
process.chdir(tmpdir())
try {
  const progress: number[] = []
  await downloadPlaylist({ src: `${base}/redirect`, dest: join(dir, 'result.mp4'), ref: '', key: `${kid}:${key}`, select: 'video', transport: 'node', threads: 4, cb: (n) => progress.push(n),
    refreshSource: async () => {
      const version = ++refreshCalls
      // Longer than RE's 20s zero-speed watchdog: restarting the process must
      // retain its segment directory and await the same fresh-URL request.
      if (version === 1) await new Promise(resolve => setTimeout(resolve, 22000))
      return { src: `${base}/video.m3u8?v=${version}`, key: `${kid}:${key}` }
    },
  })
  const transport = JSON.parse(readFileSync(join(dir, 'result.mp4.transport.json'), 'utf8'))
  if (transport.threads !== 4 || transport.peakConcurrentRequests < 2) throw new Error('Configured RE concurrency did not reach the CDN relay')
  console.log(`PASS: RE threads=4, measured concurrent relay requests=${transport.peakConcurrentRequests}`)
  await downloadPlaylist({ src: `${base}/audio.m3u8`, dest: join(dir, 'result-audio.mp4'), ref: '', clear: true, select: 'audio', transport: 'node' })
  await downloadPlaylist({ src: `${base}/encrypted-audio.m3u8`, dest: join(dir, 'result-encrypted-audio.mp4'), ref: '', key: `${kid}:${key}`, select: 'audio', transport: 'node' })
  await validateAudio(ffmpeg, join(dir, 'result-encrypted-audio.mp4'))
  const packets = async (file: string, type: 'v' | 'a') => {
    const text = await run(ffmpeg, ['-v', 'error', '-copyts', '-i', file, '-map', `0:${type}:0`, '-c', 'copy',
      '-avoid_negative_ts', 'disabled', '-f', 'framecrc', 'pipe:1'])
    const tb = /#tb 0: (\d+)\/(\d+)/.exec(text)!
    const scale = Number(tb[1]) / Number(tb[2])
    return text.split('\n').filter(l => /^0,/.test(l)).map(l => {
      const fields = l.split(',')
      return { pts: Number(fields[2]) * scale, crc: fields[5]!.trim() }
    })
  }
  for (const [source, result, type] of [
    ['source.mp4', 'result.mp4', 'v'], ['audio.mp4', 'result-encrypted-audio.mp4', 'a'],
  ] as const) {
    const expected = await packets(source, type), actual = await packets(result, type)
    if (expected.length !== actual.length || expected.some((p, i) => p.crc !== actual[i]!.crc || Math.abs(p.pts - actual[i]!.pts) > 0.001)) {
      throw new Error(`Whole-track decryption changed ${type} packet data or presentation timestamps`)
    }
  }
  const decrypted = readFileSync(join(dir, 'result-encrypted-audio.mp4'))
  let movies = 0
  for (let pos = 0; pos + 8 <= decrypted.length;) {
    let size = decrypted.readUInt32BE(pos)
    if (size === 1) size = Number(decrypted.readBigUInt64BE(pos + 8))
    if (size < 8) break
    if (decrypted.toString('ascii', pos + 4, pos + 8) === 'moov') movies++
    pos += size
  }
  if (movies !== 1) throw new Error(`Expected one movie header, found ${movies}`)
  console.log('PASS: whole-track decryption preserves every video/audio packet and PTS; one moov')
  await mkvmergeMux(await ensureMkvmerge(), join(dir, 'result.mp4'), [{ path: join(dir, 'result-audio.mp4') }, { path: join(dir, 'result-encrypted-audio.mp4') }], join(dir, 'result.mkv'))
  await run(ffmpeg, ['-v', 'error', '-xerror', '-i', 'result.mkv', '-f', 'null', '-'])
  assertAudioContinuity(await inspectMediaTiming(ffmpeg, join(dir, 'result.mkv')))
  if (keyRequests !== 0) throw new Error(`Unexpected key URI requests: ${keyRequests}`)
  if (wrongHeaders !== 0) throw new Error(`CDN requests bypassed JS transport: ${wrongHeaders}`)
  if (transientDenied !== 3 || refreshCalls !== 3) throw new Error(`Expected 3 new URLs: failures=${transientDenied}, refreshes=${refreshCalls}`)
  if (requestPaths.filter(p => p.startsWith('/video-1.m4s')).length !== 1) throw new Error('Already completed segment was downloaded again')
  console.log('PASS: three expired URLs replaced with fresh URLs in the same RE task; completed segment not downloaded again')
  console.log('PASS: playlist, redirect, init and every media segment use the original JS request headers')
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
  await new Promise<void>(resolve => server.close(() => resolve()))
}
// Bun on Windows may keep fetch/child-process handles alive after the fixture
// server has closed. Reach this only after every assertion and cleanup passed;
// an uncaught failure above still exits nonzero instead of being masked.
process.exit(0)
