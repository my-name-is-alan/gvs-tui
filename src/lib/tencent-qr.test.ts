import { test, expect } from 'bun:test'
import { defaultConfig } from './config.ts'
import { GwClient } from './client.ts'
import {
  pollTencentDualQR,
  pollTencentQR,
  startTencentDualQR,
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
    expect(tencentPlayInput(cfg).session_type).toBe(mode)
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

test('TV login input defaults tv_fp_profile=virtual_ott_4k when device empty', () => {
  const cfg = defaultConfig()
  const prev = process.env.TENCENT_TV_FP_PROFILE
  delete process.env.TENCENT_TV_FP_PROFILE
  try {
    expect(tencentTVLoginInput(cfg).tv_fp_profile).toBe('virtual_ott_4k')
    cfg.tencentTVDevice = 'ABC'
    cfg.tencentTVQUA = 'QV=1'
    expect(tencentTVLoginInput(cfg).tv_fp_profile).toBeUndefined()
  } finally {
    if (prev === undefined) delete process.env.TENCENT_TV_FP_PROFILE
    else process.env.TENCENT_TV_FP_PROFILE = prev
  }
})

test('dual QR starts app+tv and polls both', async () => {
  const cfg = defaultConfig()
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
  expect(calls.some((c) => c.method === 'tv' && c.tv_fp_profile === 'virtual_ott_4k')).toBe(true)
  calls.length = 0
  await pollTencentDualQR(cli)
  expect(calls.filter((c) => c.state === 'check')).toHaveLength(2)
})
