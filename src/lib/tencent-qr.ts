import type { FileConfig } from './config.ts'
import type { GwClient } from './client.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configPath } from './config.ts'
import { openQrPng } from './youku-qr.ts'

export type TencentMode = 'web' | 'app' | 'tv'
export type TencentDualMode = 'app' | 'tv'

export const tencentLabels = {
  web: '腾讯网页 QQ 扫码',
  app: '腾讯 App 扫码',
  tv: '腾讯极光 TV 扫码',
} as const

export function tencentPlayInput(cfg: FileConfig): Record<string, string> {
  const mode = cfg.tencentMode
  if (mode === 'web') return { session_type: 'web', tier: 'h5' }
  if (mode === 'app') return { session_type: 'app', tier: 'phone' }
  if (mode === 'tv') return { session_type: 'tv' }
  return {}
}

/** TV QR defaults: explicit cfg → env TENCENT_TV_FP_PROFILE → virtual_ott_4k. */
export function tencentTVLoginInput(cfg: FileConfig): Record<string, string> {
  const input: Record<string, string> = {
    tvid: cfg.tencentTVDevice || '',
    qua_info: cfg.tencentTVQUA || '',
    appver: cfg.tencentTVVersion || '',
  }
  const profile =
    (process.env.TENCENT_TV_FP_PROFILE || '').trim() || 'virtual_ott_4k'
  if (!input.tvid && !input.qua_info) {
    input.tv_fp_profile = profile
  }
  return input
}

async function saveOfficialPng(
  mode: string,
  data: Record<string, unknown>,
): Promise<string> {
  const encoded = typeof data.qr_png_base64 === 'string' ? data.qr_png_base64 : ''
  if (!encoded) throw new Error('网关未返回二维码图片，请更新本地网关；原 Cookie 未修改')
  const bytes = Buffer.from(encoded, 'base64')
  if (
    bytes.length > 2 * 1024 * 1024 ||
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
  ) {
    throw new Error('网关返回的二维码不是有效 PNG')
  }
  const dir = join(dirname(configPath()), 'tencent-qr')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${mode}-${Date.now()}.png`)
  writeFileSync(path, bytes, { mode: 0o600 })
  await openQrPng(path)
  return path
}

export async function startTencentQR(
  cli: Pick<GwClient, 'invoke'>,
  cfg: FileConfig,
  mode: TencentMode,
) {
  const input: Record<string, string> = {
    method: mode === 'web' ? 'qr' : mode,
    session_type: mode,
    force: '1',
  }
  if (mode === 'tv') Object.assign(input, tencentTVLoginInput(cfg))
  const data = await cli.invoke('tencent', 'login', input)
  return saveOfficialPng(mode, data)
}

/** Simultaneously issue App + TV official QR PNGs (dual path). */
export async function startTencentDualQR(
  cli: Pick<GwClient, 'invoke'>,
  cfg: FileConfig,
): Promise<{ appPath: string; tvPath: string }> {
  const appInput = { method: 'app', session_type: 'app', force: '1' }
  const tvInput = {
    method: 'tv',
    session_type: 'tv',
    force: '1',
    ...tencentTVLoginInput(cfg),
  }
  const [appData, tvData] = await Promise.all([
    cli.invoke('tencent', 'login', appInput),
    cli.invoke('tencent', 'login', tvInput),
  ])
  const appPath = await saveOfficialPng('app', appData)
  const tvPath = await saveOfficialPng('tv', tvData)
  return { appPath, tvPath }
}

export function pollTencentQR(cli: Pick<GwClient, 'invoke'>, mode: TencentMode) {
  return cli.invoke('tencent', 'login', {
    method: mode === 'web' ? 'qr' : mode,
    session_type: mode,
    state: 'check',
  })
}

export async function pollTencentDualQR(
  cli: Pick<GwClient, 'invoke'>,
): Promise<{
  app: Record<string, unknown>
  tv: Record<string, unknown>
}> {
  const [app, tv] = await Promise.all([
    pollTencentQR(cli, 'app'),
    pollTencentQR(cli, 'tv'),
  ])
  return { app, tv }
}
