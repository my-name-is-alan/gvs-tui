import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobHub, type DlTask, type JobEvt } from './jobs.ts'
import { fileFingerprint } from './gvs-record.ts'
import type { FileConfig } from './config.ts'
import type { GwClient } from './client.ts'

const tools = ['ffmpeg', 'ffprobe', 'mkvmerge'].every(bin => spawnSync(bin, [bin === 'mkvmerge' ? '--version' : '-version'], { stdio: 'ignore' }).status === 0)
const mediaTest = tools ? test : test.skip

mediaTest('Tencent runner centrally records final rendition and creates no JSON in video directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gvs-actual-runner-'))
  const previous = process.env.GVS_VERSION_RECORDS_PATH
  process.env.GVS_VERSION_RECORDS_PATH = join(root, 'profile', 'actual-versions.jsonl')
  try {
    const fixture = join(root, 'fixture.mp4')
    const made = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=25:d=0.2',
      '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=0.2', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', fixture])
    expect(made.status).toBe(0)
    const bytes = readFileSync(fixture)
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
      if (new URL(req.url).pathname === '/expired.mp4') return new Response('expired', { status: 403 })
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get('range') || '')
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : bytes.length - 1
      return new Response(bytes.subarray(start, end + 1), { status: range ? 206 : 200, headers: {
        'content-type': 'video/mp4', 'content-length': String(end - start + 1), 'accept-ranges': 'bytes',
        ...(range ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}),
      } })
    } })
    try {
      for (const scenario of ['same', 'different', 'unknown', 'refresh'] as const) {
        let calls = 0
        const cli = {
          extra: () => ({}), observeTencentTransfer: () => {},
          invoke: async () => {
            calls += 1
            const url = `${server.url}${scenario === 'refresh' && calls === 1 ? 'expired.mp4' : 'video.mp4'}?token=SIGNED_SECRET`
            if (scenario === 'same' || (scenario === 'refresh' && calls === 1)) return { formats: [
              { url, id: '322157', name: 'suhd', caption: 'hard', persona: '2741517771455_硬' },
            ] }
            return { video: { url, ...(scenario === 'unknown' ? {} : { format_id: '322093', defn: 'suhd' }) },
              formats: [{ id: '322157', name: 'suhd', persona: '2741517771455_硬' }] }
          },
        } as unknown as GwClient
        const cfg = { outDir: root, tmpDir: join(root, 'tmp'), threads: 1, releaseGroup: 'TEST', tmdbKey: '' } as FileConfig
        const task: DlTask = { provider: 'tencent', title: scenario, series: scenario, vid: `vid-${scenario}`, season: 0,
          episode: 0, kind: 'movie', height: 2160, quality: 'suhd', caption: 'hard',
          tencentQuality: { formatId: '322157', persona: '2741517771455_硬', group: 'encode' },
          group: 'TEST', codec: 'H264', tmdbId: 0, nameDots: '', year: 2026, plot: '' }
        const { promise, resolve } = Promise.withResolvers<JobEvt>()
        const hub = new JobHub(e => { if (e.done) resolve(e) })
        hub.enqueue(cfg, cli, 1, task)
        const final = await promise
        expect(final.err).toBe('')
        expect(final.actualVersion).toBeDefined()
        const records = readFileSync(process.env.GVS_VERSION_RECORDS_PATH!, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        const record = records.find(entry => entry.output === final.log)?.actualVersion
        expect(existsSync(`${final.log}.gvs.json`)).toBe(false)
        expect(record).toEqual(final.actualVersion)
        expect(record.file).toEqual(fileFingerprint(final.log))
        expect(record.media).toMatchObject({ status: 'probed', width: 64, height: 64, codec: 'h264' })
        expect(JSON.stringify(record)).not.toContain('SIGNED_SECRET')
        expect(JSON.stringify(record)).not.toContain(String(server.port))
        expect(record.status).toBe(scenario === 'unknown' ? 'unknown' : 'confirmed')
        expect(record.matchesSelection).toBe(scenario === 'same' ? 'same' : scenario === 'unknown' ? 'unknown' : 'different')
        expect(record.refreshes).toBe(scenario === 'refresh' ? 1 : 0)
        if (scenario === 'refresh') expect(record.actual.formatId).toBe('322093')
        await hub.cancelAll('pause')
      }
    } finally { await server.stop(true) }
  } finally {
    if (previous === undefined) delete process.env.GVS_VERSION_RECORDS_PATH
    else process.env.GVS_VERSION_RECORDS_PATH = previous
    rmSync(root, { recursive: true, force: true })
  }
}, 45_000)
