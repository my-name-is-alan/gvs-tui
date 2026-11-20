import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runTask, type DlTask, type JobEvt } from './jobs.ts'
import { defaultConfig } from './config.ts'
import { lookHostFFmpeg } from './tools.ts'
import type { GwClient } from './client.ts'
import { MOBILE42_PROFILE } from './tencent-mobile42.ts'

test.skipIf(process.env.GVS_MEDIA_TESTS !== '1' || process.platform === 'win32')('synthetic shared runTask mobile42 route completes with explicit helper/mux façades and real local FFmpeg verification', async () => {
  const ffmpeg = lookHostFFmpeg()
  expect(ffmpeg).not.toBe('')
  const dir = mkdtempSync(join(tmpdir(), 'mobile42-job-'))
  const previous = { helper: process.env.GVS_TENCENT_MOBILE42_DECODE, mux: process.env.MKVMERGE, records: process.env.GVS_VERSION_RECORDS_PATH, log: process.env.GVS_TUI_LOG_PATH }
  const originalFetch = globalThis.fetch
  try {
    const first = join(dir, 'source-0.ts'), last = join(dir, 'source-1.ts')
    execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=320x240:r=25:d=2',
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25',
      '-c:a', 'aac', '-f', 'segment', '-segment_time', '1', '-segment_format', 'mpegts', join(dir, 'source-%d.ts')], { windowsHide: true })
    expect(existsSync(first) && existsSync(last)).toBe(true)
    const helper = join(dir, 'helper'), mux = join(dir, 'mux')
    const helperScript = `#!/usr/bin/env node\nconst f=require('fs'),c=require('crypto');const a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1];const doc=JSON.parse(f.readFileSync(get('--response')));if(doc.data.protocol!=='mobile42')process.exit(2);const b=f.readFileSync(get('--segment'));f.writeFileSync(get('--output'),b,{flag:'wx',mode:0o600});process.stdout.write('decoded_bytes='+b.length+' sha256='+c.createHash('sha256').update(b).digest('hex')+' network_requests=0 native_runtime=false\\n');`
    // Test-only replacement for missing macOS mkvmerge; this does not validate the packaged mux binary.
    const muxScript = `#!/usr/bin/env node\nconst s=require('child_process'),a=process.argv.slice(2);if(a.includes('-J')){console.log(JSON.stringify({tracks:[{id:0,type:'video',properties:{}},{id:1,type:'audio',properties:{}}]}));process.exit(0)}const out=a[a.indexOf('-o')+1],input=a[a.length-1];const p=s.spawnSync(${JSON.stringify(ffmpeg)},['-nostdin','-v','error','-i',input,'-c','copy','-y',out],{stdio:['ignore','ignore','pipe']});process.exit(p.status||0);`
    writeFileSync(helper, helperScript, { mode: 0o700 }); writeFileSync(`${helper}.sha256`, createHash('sha256').update(helperScript).digest('hex'))
    writeFileSync(mux, muxScript, { mode: 0o700 })
    process.env.GVS_TENCENT_MOBILE42_DECODE = helper
    process.env.MKVMERGE = mux
    process.env.GVS_VERSION_RECORDS_PATH = join(dir, 'versions.jsonl')
    process.env.GVS_TUI_LOG_PATH = join(dir, 'job.log')
    const vid = 'l4102y2spzy'
    const context = { Account: { UserID: 'fixture' }, Device: { GUID: 'fixture' }, Scene: { VID: vid }, Signing: { DD: 'PRIVATE_SIGNING' }, Source: {} }
    const key = '#EXT-X-KEY:METHOD=0E9CA2BAE3E3CCC9,URI="data:text/plain;base64,dHhkaWQ9QTU4NEMyQ0I0NTY1M0I4NQ==",KEYFORMAT="com.tencent.qqlive"'
    const payload = { protocol: 'mobile42', vid, duration: 2, manifest: `#EXTM3U\n${key}\n#EXTINF:1,\nhttps://fixture.invalid/0.ts\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:1,\nhttps://fixture.invalid/1.ts\n#EXT-X-ENDLIST\n`, media: [{ type: 'video', url: 'https://fixture.invalid/list.m3u8', width: 320, height: 240, quality: 'fhd', drm: {
      need_decrypt: true, supported: true, enc: 0, client_profile: MOBILE42_PROFILE, crypto_context: { version: 1, profile: MOBILE42_PROFILE, transport: 'chacha20_v3', transport_offset_origin: 'hls_segment', codec: 'sdd_v2_hevc',
        transport_key_b64: Buffer.alloc(32).toString('base64'), transport_nonce_b64: Buffer.alloc(12).toString('base64'), codec_key_b64: Buffer.alloc(32).toString('base64'), codec_nonce_b64: Buffer.alloc(12).toString('base64') } } }] }
    const calls: Record<string, unknown>[] = [], fetched: string[] = []
    const cli = { invoke: async (p: string, a: string, input: Record<string, unknown>) => {
      expect([p, a]).toEqual(['tencent', 'play']); calls.push(input); return payload
    }, extra: () => ({}), observeTencentTransfer: (bytes: number) => expect(bytes).toBeGreaterThan(0) } as unknown as GwClient
    globalThis.fetch = (async input => {
      const url = String(input)
      if (!['https://fixture.invalid/0.ts', 'https://fixture.invalid/1.ts'].includes(url)) throw new Error('test blocked nonfixture request')
      fetched.push(url)
      const raw = readFileSync(url.endsWith('/0.ts') ? first : last)
      return new Response(raw, { headers: { 'Content-Length': String(raw.length) } })
    }) as typeof fetch
    const cfg = { ...defaultConfig(), outDir: join(dir, 'library'), tmpDir: join(dir, 'work'), releaseGroup: '', threads: 2, tencentMode: 'app' as const,
      tencentMobile42: { accountSource: 'app_sync' as const, context } }
    const task: DlTask = { provider: 'tencent', title: 'Fixture', series: 'Fixture', vid, season: 1, episode: 1, duration: 2, height: 0, quality: 'fhd', codec: 'H.264',
      tencentQuality: { width: 320, height: 240, fps: 25 }, year: 2026, group: '', tmdbId: 0, nameDots: '', plot: '', kind: 'show' }
    const events: JobEvt[] = []
    await runTask(event => events.push(event), cfg, cli, 1, task, AbortSignal.timeout(30_000))
    const final = [...events].reverse().find(event => event.done)!
    expect(final.err).toBe('')
    expect(final.status).toBe('完成')
    expect(existsSync(final.log)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.protocol).toBe('mobile42')
    expect(calls[0]!.session_type).toBe('app')
    expect(JSON.parse(String(calls[0]!.mobile)).Scene.VID).toBe(vid)
    expect(fetched.sort()).toEqual(['https://fixture.invalid/0.ts', 'https://fixture.invalid/1.ts'])
    execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-i', final.log, '-f', 'null', '-'], { windowsHide: true })
    const history = JSON.stringify(events) + readFileSync(process.env.GVS_VERSION_RECORDS_PATH, 'utf8') + readFileSync(process.env.GVS_TUI_LOG_PATH, 'utf8')
    for (const secret of ['PRIVATE_SIGNING', 'crypto_context', 'transport_key_b64', 'data:text/plain']) expect(history).not.toContain(secret)
    const scratch = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? [entry.name, ...scratch(join(path, entry.name))] : [entry.name])
    expect((existsSync(cfg.tmpDir) ? scratch(cfg.tmpDir) : []).some(name => /response\.json|\.source|\.clear|tx-mobile42-/.test(name))).toBe(false)
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries({ GVS_TENCENT_MOBILE42_DECODE: previous.helper, MKVMERGE: previous.mux, GVS_VERSION_RECORDS_PATH: previous.records, GVS_TUI_LOG_PATH: previous.log })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)
