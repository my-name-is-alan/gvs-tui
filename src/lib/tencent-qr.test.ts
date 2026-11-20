import { test, expect } from 'bun:test'
import { defaultConfig } from './config.ts'
import { GwClient } from './client.ts'
import {
  pollTencentDualQR,
  pollTencentQR,
  startTencentDualQR,
  applyTencentLogin,
  tencentPlayInput,
  tencentTVLoginInput,
} from './tencent-qr.ts'

test('Tencent profiles route independently and never send pasted cookie', async () => {
  const cfg = defaultConfig()
  cfg.tencentCookie = 'EXISTING'
  const cli = new GwClient('http://localhost', 'key')
  for (const mode of ['web', 'app', 'tv'] as const) {
    cfg.tencentMode = mode
    expect(cli.extra(cfg, 'tencent')).toEqual({})
    if (mode === 'app') expect(() => tencentPlayInput(cfg)).toThrow('网页会话')
    else expect(tencentPlayInput(cfg).session_type).toBe(mode)
    const calls: unknown[] = []
    await pollTencentQR(
      {
        invoke: async (...args: unknown[]) => {
          calls.push(args)
          return {}
        },
      },
      mode,
    )
    expect(calls).toEqual([
      [
        'tencent',
        'login',
        {
          method: mode === 'web' ? 'qr' : mode,
          session_type: mode,
          state: 'check',
        },
      ],
    ])
    expect(cfg.tencentCookie).toBe('EXISTING')
  }
  cfg.tencentMode = 'cookie'
  expect(cli.extra(cfg, 'tencent')).toEqual({ 'Tx-Cookie': 'EXISTING' })
  expect(tencentPlayInput(cfg)).toEqual({})
})

test('successful Tencent scan keeps only mode/tvid locally; cookie stays on the gateway', () => {
  const cfg = defaultConfig()
  cfg.tencentCookie = 'stale-local-cookie'
  const ok = applyTencentLogin(cfg, 'tv', {
    logged_in: true,
    cookie: 'vuserid=1; vusession=abc',
    tvid: 'TVDEV',
  })
  expect(ok).toBe(true)
  expect(cfg.tencentMode).toBe('tv')
  // 瘦客户端：扫码 Cookie 由网关加密托管，本地不再保存副本。
  expect(cfg.tencentCookie).toBe('')
  expect(cfg.tencentTVDevice).toBe('TVDEV')
  expect(applyTencentLogin(cfg, 'app', { logged_in: false, cookie: 'nope' })).toBe(false)
  expect(cfg.tencentMode).toBe('tv')
})

test('App-authorized website QR never switches or clears the active playback identity', () => {
  for (const selected of ['cookie', 'web', 'tv', 'app'] as const) {
    const cfg = defaultConfig()
    cfg.tencentMode = selected
    cfg.tencentCookie = 'EXISTING-EXPLICIT-ACCOUNT'
    const before = structuredClone(cfg)
    expect(applyTencentLogin(cfg, 'app', {
      logged_in: true, credential_type: 'web_account', native_app_credential: false,
      cookie: 'WEBSITE-CREDENTIAL-MUST-NOT-BE-IMPORTED',
    })).toBe(true)
    expect(cfg).toEqual(before)
  }
})

test('TV login input uses a preset unless the custom device identity is complete', () => {
  const cfg = defaultConfig()
  const prev = process.env.TENCENT_TV_FP_PROFILE
  delete process.env.TENCENT_TV_FP_PROFILE
  try {
    expect(tencentTVLoginInput(cfg)).toEqual({ tv_fp_profile: 'virtual_ott_4k' })
    cfg.tencentTVDevice = 'ABC'
    cfg.tencentTVQUA = 'QV=1'
    expect(tencentTVLoginInput(cfg)).toEqual({ tv_fp_profile: 'virtual_ott_4k' })
    cfg.tencentTVVersion = '20.0.0.1008'
    expect(tencentTVLoginInput(cfg)).toEqual({ tvid: 'ABC', qua_info: 'QV=1', appver: '20.0.0.1008' })
  } finally {
    if (prev === undefined) delete process.env.TENCENT_TV_FP_PROFILE
    else process.env.TENCENT_TV_FP_PROFILE = prev
  }
})

test('TV login after a successful scan does not send the saved device as an incomplete override', () => {
  const cfg = defaultConfig()
  const prev = process.env.TENCENT_TV_FP_PROFILE
  delete process.env.TENCENT_TV_FP_PROFILE
  try {
    applyTencentLogin(cfg, 'tv', { logged_in: true, tvid: 'SAVED-TV-DEVICE' })
    const saved = { ...cfg }
    expect(tencentTVLoginInput(cfg)).toEqual({ tv_fp_profile: 'virtual_ott_4k' })
    expect(cfg).toEqual(saved)
  } finally {
    if (prev === undefined) delete process.env.TENCENT_TV_FP_PROFILE
    else process.env.TENCENT_TV_FP_PROFILE = prev
  }
})

test('partial TV device settings use the configured preset without leaking partial fields', () => {
  const prev = process.env.TENCENT_TV_FP_PROFILE
  process.env.TENCENT_TV_FP_PROFILE = ' custom-preset '
  try {
    for (let mask = 0; mask < 7; mask++) {
      const cfg = defaultConfig()
      cfg.tencentTVDevice = mask & 1 ? 'DEVICE' : ' '
      cfg.tencentTVQUA = mask & 2 ? 'QV=1' : ''
      cfg.tencentTVVersion = mask & 4 ? '20.0.0.1008' : undefined
      expect(tencentTVLoginInput(cfg)).toEqual({ tv_fp_profile: 'custom-preset' })
    }
    const cfg = defaultConfig()
    cfg.tencentTVDevice = ' DEVICE '
    cfg.tencentTVQUA = ' QV=1 '
    cfg.tencentTVVersion = ' 20.0.0.1008 '
    expect(tencentTVLoginInput(cfg)).toEqual({ tvid: 'DEVICE', qua_info: 'QV=1', appver: '20.0.0.1008' })
  } finally {
    if (prev === undefined) delete process.env.TENCENT_TV_FP_PROFILE
    else process.env.TENCENT_TV_FP_PROFILE = prev
  }
})

test('dual QR starts app+tv and polls both', async () => {
  const cfg = defaultConfig()
  applyTencentLogin(cfg, 'tv', { logged_in: true, tvid: 'SAVED-TV-DEVICE' })
  const calls: Array<Record<string, string>> = []
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ).toString('base64')
  const cli = {
    invoke: async (_p: string, _a: string, input: Record<string, string>) => {
      calls.push({ ...input })
      if (input.state === 'check') return { logged_in: false, status: 'wait' }
      return { qr_png_base64: png }
    },
  }
  // openQrPng may fail silently on headless; start still writes files
  const paths = await startTencentDualQR(cli, cfg)
  expect(paths.appPath).toContain('app-')
  expect(paths.tvPath).toContain('tv-')
  expect(calls.some((c) => c.method === 'app' && c.force === '1')).toBe(true)
  expect(calls.find((c) => c.method === 'tv')).toEqual({
    method: 'tv', session_type: 'tv', force: '1', tv_fp_profile: 'virtual_ott_4k',
  })
  calls.length = 0
  await pollTencentDualQR(cli)
  expect(calls.filter((c) => c.state === 'check')).toHaveLength(2)
})
