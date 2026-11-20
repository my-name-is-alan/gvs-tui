import { afterEach, expect, test } from 'bun:test'
import { defaultConfig } from './config.ts'
import { GwClient } from './client.ts'
import { tencentPlayInput } from './tencent-qr.ts'
import { setRunLogDisabled } from './runlog.ts'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

afterEach(() => setRunLogDisabled(false))
const vid = 'l4102y2spzy'
const context = { Account: { UserID: 'fixture' }, Device: { GUID: 'fixture' }, Scene: { VID: vid, Defn: 'fhd' }, Signing: { DD: 'PRIVATE_SIGNING_MATERIAL' }, Source: {} }

test('mobile42 requires explicit native configuration and rejects the website QR as a phone route', () => {
  const cfg = defaultConfig()
  cfg.tencentMode = 'app'
  expect(() => tencentPlayInput(cfg)).toThrow('网页会话')
  cfg.tencentMobile42 = { accountSource: 'app_sync', context }
  expect(tencentPlayInput(cfg)).toEqual({ protocol: 'mobile42', session_type: 'app', account_source: 'app_sync', mobile: JSON.stringify(context) })
  expect(() => tencentPlayInput(cfg, { edition: 'imax', defn: 'imax', session_type: 'tv' })).toThrow('不能与 TV/IMAX 混用')
  cfg.tencentMode = 'tv'
  expect(() => tencentPlayInput(cfg)).toThrow('不能与 TV/IMAX 混用')
  cfg.tencentMode = 'app'
  cfg.tencentMobile42 = { accountSource: 'gateway', context: { ...context, Account: { Cookie: '' } } }
  expect(() => tencentPlayInput(cfg)).toThrow('不能携带 Cookie')
})

test('mobile42 success and failure logs/diagnostics never serialize signing, crypto context, manifest or signed URLs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile42-private-log-'))
  const oldLog = process.env.GVS_TUI_LOG_PATH, oldDiag = process.env.GVS_TENCENT_DIAGNOSTICS_PATH
  process.env.GVS_TUI_LOG_PATH = join(dir, 'run.log')
  process.env.GVS_TENCENT_DIAGNOSTICS_PATH = join(dir, 'diagnostics.jsonl')
  setRunLogDisabled(false)
  let fail = false
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json(fail
    ? { code: 4001, msg: 'fixture rejected' }
    : { code: 0, msg: 'SUCCESS', data: { vid, protocol: 'mobile42', has_url: true,
      manifest: 'PRIVATE_MANIFEST', drm: { crypto_context: { key: 'PRIVATE_CRYPTO' } }, media: [{ url: 'https://fixture.invalid/?token=PRIVATE_URL' }] } }) })
  try {
    const cfg = { ...defaultConfig(), host: server.url.origin, key: 'fixture' }
    const cli = new GwClient(cfg.host, cfg.key, () => cfg)
    const input = { protocol: 'mobile42', session_type: 'app', account_source: 'app_sync', vid, mobile: JSON.stringify(context) }
    await cli.invoke('tencent', 'play', input)
    fail = true
    await expect(cli.invoke('tencent', 'play', input)).rejects.toThrow()
    const logs = readFileSync(process.env.GVS_TUI_LOG_PATH, 'utf8') + readFileSync(process.env.GVS_TENCENT_DIAGNOSTICS_PATH, 'utf8')
    expect(logs).toContain('mobile=[private]')
    for (const secret of ['PRIVATE_SIGNING_MATERIAL', 'PRIVATE_CRYPTO', 'PRIVATE_MANIFEST', 'PRIVATE_URL', 'crypto_context', 'Signing']) expect(logs).not.toContain(secret)
  } finally {
    server.stop(true)
    if (oldLog === undefined) delete process.env.GVS_TUI_LOG_PATH; else process.env.GVS_TUI_LOG_PATH = oldLog
    if (oldDiag === undefined) delete process.env.GVS_TENCENT_DIAGNOSTICS_PATH; else process.env.GVS_TENCENT_DIAGNOSTICS_PATH = oldDiag
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const source of ['tui_process', 'electron_process'] as const) test(`${source}: mobile42 job requests bind real episode and never enter TV reports even with stale TV config`, async () => {
  setRunLogDisabled(true)
  const calls: Array<{ action: string; input: Record<string, unknown> }> = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json() as { action: string; input: Record<string, unknown> }
    calls.push(body)
    return Response.json({ code: 0, data: { vid, protocol: 'mobile42', has_url: true } })
  } })
  try {
    const cfg = { ...defaultConfig(), host: server.url.origin, key: 'fixture', tencentMode: 'tv' as const }
    const cli = new GwClient(cfg.host, cfg.key, () => cfg, source)
    await cli.invoke('tencent', 'play', { protocol: 'mobile42', session_type: 'app', account_source: 'app_sync', vid, defn: 'suhd', mobile: JSON.stringify(context) })
    cli.observeTencentTransfer(123, 0)
    await cli.closeTencentTransfer()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.action).toBe('play')
    expect(calls[0]!.input.report_binding).toBeUndefined()
    expect(calls[0]!.input.session_type).toBe('app')
    expect(JSON.parse(String(calls[0]!.input.mobile)).Scene).toEqual({ VID: vid, Defn: 'suhd' })
    await expect(cli.invoke('tencent', 'play', { protocol: 'mobile42', session_type: 'tv' })).rejects.toThrow('配置无效')
    expect(calls).toHaveLength(1)
  } finally { server.stop(true) }
})
