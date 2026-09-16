import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import QRCode from 'qrcode'
import type { GwClient } from './client.ts'
import { configPath } from './config.ts'
import { asBool, asString, isObj } from './util.ts'

export function hostIsLocal(host: string): boolean {
  try {
    const h = new URL(host).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '::1'
  } catch {
    return false
  }
}

export async function qrAscii(url: string): Promise<string> {
  if (!url) return ''
  return QRCode.toString(url, { type: 'utf8', errorCorrectionLevel: 'M' })
}

const QR_PNG = 'youku_qr_login.png'

export async function writeQrPng(url: string, file: string): Promise<string> {
  if (!url) throw new Error('empty qr url')
  const abs = resolve(file)
  mkdirSync(dirname(abs), { recursive: true })
  await QRCode.toFile(abs, url, {
    type: 'png',
    width: 512,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  })
  return abs
}

/** AppData/gvs/youku-qr plus ./youku-qr under the process cwd. */
export function youkuQrPngTargets(): string[] {
  const app = resolve(join(dirname(configPath()), 'youku-qr', QR_PNG))
  const folder = resolve(join('.', 'youku-qr', QR_PNG))
  return app === folder ? [app] : [app, folder]
}

export type YoukuQRStart = {
  ticket: string
  loginToken: string
  ascii: string
  pngPaths: string[]
}

export async function startYoukuQR(cli: GwClient): Promise<YoukuQRStart> {
  const data = await cli.invoke('youku', 'login', { method: 'qr', force: '1' })
  const ticket = asString(data.yk_ticket) || asString(data.ticket)
  const loginToken = asString(data.loginToken) || asString(data.login_token)
  const url = asString(data.qrCodeUrl) || asString(data.qr_url) || asString(data.url)
  if (!ticket && !loginToken) throw new Error('网关没有返回 yk_ticket')
  if (!url) throw new Error('网关没有返回二维码 URL')
  const pngPaths: string[] = []
  for (const file of youkuQrPngTargets()) {
    try {
      pngPaths.push(await writeQrPng(url, file))
    } catch {
      // cwd may be unwritable; AppData copy is enough
    }
  }
  return { ticket, loginToken, ascii: await qrAscii(url), pngPaths }
}

export type YoukuQRPoll = {
  sign: string
  loggedIn: boolean
}

export async function pollYoukuQR(cli: GwClient, ticket: string, loginToken = ''): Promise<YoukuQRPoll> {
  const input: Record<string, string> = { method: 'qr', state: 'check' }
  if (ticket) input.yk_ticket = ticket
  if (loginToken) input.loginToken = loginToken
  const data = await cli.invoke('youku', 'login', input)
  return {
    sign: asString(data.yk_sign) || asString(data.sign),
    loggedIn: asBool(data.logged_in),
  }
}

export type YoukuCookieImport = {
  sign: string
  accountInfo?: Record<string, unknown>
}

export async function importYoukuCookie(cli: GwClient, cookie: string): Promise<YoukuCookieImport> {
  const data = await cli.invoke('youku', 'login', { method: 'cookie', cookie })
  const sign = asString(data.yk_sign) || asString(data.sign)
  if (!sign) throw new Error('没有 yk_sign，Cookie 可能缺 P_sck')
  return {
    sign,
    accountInfo: isObj(data.account_info) ? data.account_info : undefined,
  }
}
