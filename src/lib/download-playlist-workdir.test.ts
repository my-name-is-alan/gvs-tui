import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { downloadPlaylist, workTagOf } from './media.ts'
import { ensureFFmpeg, ensureM3u8dl, ensurePackager } from './tools.ts'

/** A tiny clear HLS playlist plus its init/segments, served from a temp folder. */
async function clearFixture(dir: string): Promise<string> {
  const ffmpeg = await ensureFFmpeg()
  const run = (args: string[]) => new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { cwd: dir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', b => { err += b })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(err)))
  })
  await run(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10', '-t', '6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', 'seg-source.mp4'])
  await run(['-v', 'error', '-i', 'seg-source.mp4', '-c', 'copy', '-hls_time', '1',
    '-hls_segment_type', 'mpegts', '-hls_list_size', '0', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', 'seg%d.ts', 'index.m3u8'])
  return 'index.m3u8'
}

test('workTagOf keeps a stable filesystem-safe folder per track', () => {
  expect(workTagOf('video', 'C:\\x\\a.4K.video.mp4')).toBe('video')
  expect(workTagOf(undefined, 'C:\\x\\a.4K.video.mp4')).toBe('a_4K_video_mp4')
  // A track id contains '|' and ':' which are invalid in a Windows folder name.
  expect(workTagOf(undefined, 'XEN|cmfa4hd5_atmos51')).toBe('XEN_cmfa4hd5_atmos51')
  expect(workTagOf('audioXEN|cmfa4hd5_atmos51|zh', 'x.mp4')).toBe('audioXEN_cmfa4hd5_atmos51_zh')
  expect(workTagOf('', '')).toBe('track')
})

test('downloadPlaylist keeps RE scratch inside the given work dir and empties it first', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gvs-workdir-'))
  const work = join(root, 'job-youku-XEN-deadbeef')
  mkdirSync(work, { recursive: true })
  // A previous interrupted run left a stale scratch folder behind.
  mkdirSync(join(work, 'video', 're-stale'), { recursive: true })
  writeFileSync(join(work, 'video', 're-stale', 'junk.bin'), 'x')

  try {
    const playlist = await clearFixture(root)
    const server = createServer((req, res) => {
      try {
        const file = readFileSync(join(root, (req.url ?? '/').replace(/^\/+/, '').replace(/\?.*$/, '')))
        res.writeHead(200, {
          'Content-Type': (req.url ?? '').endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
          'Content-Length': String(file.length),
        })
        if ((req.url ?? '').endsWith('.ts')) setTimeout(() => res.end(file), 200)
        else res.end(file)
      } catch { res.writeHead(404).end() }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const dest = join(root, 'out.mp4')
    const progress: Array<{ n: number; phase?: string; done?: number; bytes?: number; speed?: number }> = []
    try {
      await downloadPlaylist({
        src: `${base}/${playlist}`,
        dest,
        ref: '',
        clear: true,
        select: 'muxed',
        transport: 're',
        workDir: work,
        workTag: 'video',
        threads: 1,
        cb: (n, _total, info) => progress.push({ n, phase: info?.phase, done: info?.segments?.done, bytes: info?.transfer?.bytes, speed: info?.transfer?.bytesPerSecond }),
      })
      expect(statSync(dest).size).toBeGreaterThan(0)
      expect(progress.some(p => p.phase === 'download' && p.n > 0 && p.n < 0.7)).toBe(true)
      expect(progress.some(p => p.phase === 'download' && (p.bytes ?? 0) > 0 && (p.speed ?? 0) > 0)).toBe(true)
      // The stale scratch was emptied before the run and nothing was left
      // behind on success (removeScratch also drops the emptied `video` tag).
      expect(existsSync(join(work, 'video', 're-stale'))).toBe(false)
      expect(existsSync(join(work, 'video'))).toBe(false)
      // Nothing was written beside the output.
      expect(readdirSync(root).filter(n => n.startsWith('gvs-re-'))).toEqual([])
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120000)

test('a failing download keeps its scratch inside the work dir, not beside the output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gvs-workdir-fail-'))
  const work = join(root, 'job-huangguo-v1-abc123')
  try {
    const server = createServer((_req, res) => res.writeHead(500).end('boom'))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const dest = join(root, 'out.mp4')
    try {
      await expect(downloadPlaylist({
        src: `${base}/index.m3u8`, dest, ref: '', select: 'muxed', transport: 're',
        workDir: work, workTag: 'hls',
      })).rejects.toBeDefined()
      // The diagnostic log and the scratch both live under the job work dir.
      expect(existsSync(`${dest}.download-error.log`)).toBe(true)
      const scratch = readdirSync(join(work, 'hls'))
      expect(scratch.length).toBe(1)
      expect(scratch[0]!.startsWith('re-')).toBe(true)
      expect(readdirSync(root).filter(n => n.startsWith('gvs-re-'))).toEqual([])
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120000)

test('ensurePackager and ensureM3u8dl resolve so the pipeline can run', async () => {
  expect((await ensureM3u8dl()).length).toBeGreaterThan(0)
  expect((await ensurePackager()).length).toBeGreaterThan(0)
})
