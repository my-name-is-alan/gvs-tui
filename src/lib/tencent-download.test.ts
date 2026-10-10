import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { runTask, type DlTask, type JobEvt } from './jobs.ts'
import { defaultConfig } from './config.ts'
import { ensureFFmpeg } from './tools.ts'
import type { GwClient } from './client.ts'

test.skipIf(process.env.GVS_MEDIA_TESTS !== '1')('Tencent shared runner completes SDR under catalog HDR, preserves warnings and names actual specs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-tencent-download-warning-'))
  const oldRecordsPath = process.env.GVS_VERSION_RECORDS_PATH
  process.env.GVS_VERSION_RECORDS_PATH = join(dir, 'actual-versions.jsonl')
  const server = createServer()
  try {
    const ffmpeg = await ensureFFmpeg(), source = join(dir, 'source.ts')
    execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=320x240:r=60:d=2',
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709',
      '-c:a', 'aac', '-f', 'mpegts', '-y', source], { windowsHide: true })
    const bytes = readFileSync(source)
    server.on('request', (_req, res) => { res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': bytes.length }); res.end(bytes) })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port, url = `http://127.0.0.1:${port}/source.ts`
    const cli = { invoke: async (provider: string, action: string) => {
      expect([provider, action]).toEqual(['tencent', 'play'])
      return { duration: 2, formats: [{ id: '322152', name: 'maxplus', width: 320, height: 240, fps: 60, hdr: 'hdr', url }] }
    }, extra: () => ({}), observeTencentTransfer: () => {} } as unknown as GwClient
    const task: DlTask = { provider: 'tencent', namingVersion: 1, title: '节目', series: '节目', vid: 'fixture',
      season: 1, episode: 1, duration: 2, height: 2160, quality: 'maxplus', codec: 'HEVC',
      tencentQuality: { formatId: '322152', width: 320, height: 240, fps: 60, hdr: 'hdr' },
      audioTracks: [{ id: 'absent', label: 'DTS', lang: 'zh', codec: 'DTS', isDefault: true }],
      year: 2026, group: 'WF', tmdbId: 0, nameDots: '', plot: '', kind: 'show' }
    const cfg = { ...defaultConfig(), outDir: join(dir, 'library'), tmpDir: join(dir, 'work'), releaseGroup: 'WF', threads: 1 }
    const events: JobEvt[] = []
    await runTask(event => events.push(event), cfg, cli, 1, task, AbortSignal.timeout(30000))
    const final = [...events].reverse().find(event => event.done)!
    expect(final.err).toBe('')
    expect(final.status).toBe('完成')
    expect(final.note).toContain('本集无 DTS，已跳过')
    expect(final.note).toContain('所选 HDR 未在实际视频中确认')
    expect(events.some(event => event.status === '规格提示')).toBe(true)
    expect(existsSync(final.log)).toBe(true)
    expect(basename(final.log)).toBe('节目.S01E01.2026.360p.TX.WEB-DL.MAXPLUS.60fps.AVC.AAC.2.0-WF.mkv')
    expect(final.actualVersion?.media?.dynamicRange).toBe('SDR')
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    if (oldRecordsPath === undefined) delete process.env.GVS_VERSION_RECORDS_PATH
    else process.env.GVS_VERSION_RECORDS_PATH = oldRecordsPath
    rmSync(dir, { recursive: true, force: true })
  }
}, 60000)

for (const scenario of ['rebind', 'refresh', 'downgrade', 'ignored-selector'] as const) {
  test.skipIf(process.env.GVS_MEDIA_TESTS !== '1')(`Tencent episode rendition ${scenario} uses confirmed episode selectors before transferring media`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gvs-tencent-episode-rendition-'))
    const oldRecordsPath = process.env.GVS_VERSION_RECORDS_PATH
    process.env.GVS_VERSION_RECORDS_PATH = join(dir, 'actual-versions.jsonl')
    const server = createServer()
    try {
      const ffmpeg = await ensureFFmpeg(), source = join(dir, 'source.ts')
      execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=320x240:r=60:d=2',
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-f', 'mpegts', '-y', source], { windowsHide: true })
      const bytes = readFileSync(source)
      let mediaRequests = 0
      server.on('request', (req, res) => {
        mediaRequests++
        if (req.url === '/expired.ts') { res.writeHead(403); res.end(); return }
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': bytes.length }); res.end(bytes)
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      const row = { id: 'current', name: 'maxplus', width: 320, height: 240, vfps: 60,
        profile: 'h264', hdr: 'hdr', persona: 'default_硬', caption: 'hard', caption_probe: '硬' }
      const requested: Array<string | undefined> = []
      let targeted = 0, catalogs = 0
      const cli = { invoke: async (provider: string, action: string, input: Record<string, string>) => {
        expect([provider, action]).toEqual(['tencent', 'play'])
        requested.push(input.format_id)
        if (!input.format_id) {
          catalogs++
          return { formats: [{ ...row, id: catalogs > 1 ? 'refreshed' : 'current',
            ...(scenario === 'downgrade' ? { vfps: 25 } : {}) }] }
        }
        targeted++
        const id = scenario === 'refresh' && targeted >= 3 ? 'refreshed'
          : scenario === 'ignored-selector' && targeted > 1 ? 'unrelated' : 'current'
        const url = baseURL + (scenario === 'refresh' && targeted <= 2 ? '/expired.ts' : '/source.ts')
        return { duration: 2, formats: [{ ...row, id, url }],
          video: { defn: 'maxplus', format_id: id, persona: row.persona, caption: 'hard', url } }
      }, extra: () => ({}), observeTencentTransfer: () => {} } as unknown as GwClient
      const task: DlTask = { provider: 'tencent', namingVersion: 1, title: '节目', series: '节目', vid: 'fixture',
        season: 1, episode: 28, duration: 2, height: 240, quality: 'maxplus', codec: 'AVC',
        tencentQuality: { formatId: 'previous-episode', persona: 'default_硬', group: 'encode', captionProbe: 'hard',
          width: 320, height: 240, fps: 60, hdr: 'hdr' },
        year: 2026, group: 'WF', tmdbId: 0, nameDots: '', plot: '', kind: 'show' }
      const originalSelection = JSON.stringify(task.tencentQuality)
      const cfg = { ...defaultConfig(), outDir: join(dir, 'library'), tmpDir: join(dir, 'work'), releaseGroup: 'WF', threads: 1 }
      const events: JobEvt[] = []
      await runTask(event => events.push(event), cfg, cli, 1, task, AbortSignal.timeout(30000))
      const final = [...events].reverse().find(event => event.done)!
      if (scenario === 'downgrade' || scenario === 'ignored-selector') {
        expect(final.err).toContain('腾讯返回的实际版本与所选版本不同')
        expect(mediaRequests).toBe(0)
        expect(requested).toEqual(scenario === 'downgrade' ? ['previous-episode', undefined] : ['previous-episode', undefined, 'current'])
      } else {
        expect(final.err).toBe('')
        expect(existsSync(final.log)).toBe(true)
        expect(final.actualVersion?.selected.formatId).toBe(scenario === 'refresh' ? 'refreshed' : 'current')
        expect(final.actualVersion?.actual?.formatId).toBe(scenario === 'refresh' ? 'refreshed' : 'current')
        expect(final.actualVersion?.matchesSelection).toBe('same')
        expect(final.actualVersion?.refreshes).toBe(scenario === 'refresh' ? 1 : 0)
        expect(requested).toEqual(scenario === 'refresh'
          ? ['previous-episode', undefined, 'current', 'current', undefined, 'refreshed']
          : ['previous-episode', undefined, 'current'])
        expect(basename(final.log)).toContain('.TX.WEB-DL.MAXPLUS.60fps.AVC.AAC.2.0-WF.mkv')
      }
      expect(JSON.stringify(task.tencentQuality)).toBe(originalSelection)
    } finally {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
      if (oldRecordsPath === undefined) delete process.env.GVS_VERSION_RECORDS_PATH
      else process.env.GVS_VERSION_RECORDS_PATH = oldRecordsPath
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60000)
}
