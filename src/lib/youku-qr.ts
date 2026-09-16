import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import QRCode from 'qrcode'
import type { GwClient } from './client.ts'
import { asBool, asString, isObj } from './util.ts'

export function hostIsLocal(host: string): boolean {
  try {
    const h = new URL(host).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '::1'
  } catch {
    return false
  }
}

/** Windows conhost / Windows PowerShell 5.x: no █▀▄, GBK, ambiguous cell width. */
export function qrNeedsAscii(
  env: NodeJS.Dict<string> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false
  if (env.WT_SESSION || env.WT_PROFILE_ID) return false
  if (env.TERM_PROGRAM) return false
  if (env.ConEmuANSI === 'ON') return false
  return true
}

const QZ = 1
const ASCII_DARK = '##'
const ASCII_LIGHT = '  '

type QrMode = 'ascii' | 'compact'

function moduleAt(
  get: (x: number, y: number) => boolean,
  size: number,
  x: number,
  y: number,
): boolean {
  const mx = x - QZ
  const my = y - QZ
  if (mx < 0 || my < 0 || mx >= size || my >= size) return false
  return get(mx, my)
}

/** Compact uses half-blocks (2 rows/line). ASCII uses `##` — valid in GBK/CP437. */
export function renderQr(url: string, mode: QrMode): string {
  if (!url) return ''
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' })
  const n = qr.modules.size
  const dim = n + QZ * 2
  const get = (x: number, y: number) => qr.modules.get(x, y)
  const lines: string[] = []
  if (mode === 'ascii') {
    for (let y = 0; y < dim; y++) {
      let line = ''
      for (let x = 0; x < dim; x++) {
        line += moduleAt(get, n, x, y) ? ASCII_DARK : ASCII_LIGHT
      }
      lines.push(line)
    }
    return lines.join('\n')
  }
  for (let y = 0; y < dim; y += 2) {
    let line = ''
    for (let x = 0; x < dim; x++) {
      const top = moduleAt(get, n, x, y)
      const bot = y + 1 < dim && moduleAt(get, n, x, y + 1)
      line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' '
    }
    lines.push(line)
  }
  return lines.join('\n')
}

export async function qrAscii(url: string, forceAscii = qrNeedsAscii()): Promise<string> {
  return renderQr(url, forceAscii ? 'ascii' : 'compact')
}

export function openQrFile(file: string): boolean {
  if (!file) return false
  const abs = resolve(file)
  try {
    const child = process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', abs], { detached: true, stdio: 'ignore', windowsHide: true })
      : process.platform === 'darwin'
        ? spawn('open', [abs], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [abs], { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

export type YoukuQRStart = {
  ticket: string
  ascii: string
  htmlPath: string
  url: string
  asciiMode: boolean
}

export async function startYoukuQR(cli: GwClient): Promise<YoukuQRStart> {
  const data = await cli.invoke('youku', 'login', { method: 'qr', force: '1' })
  const ticket = asString(data.yk_ticket) || asString(data.ticket)
  const url = asString(data.qrCodeUrl) || asString(data.qr_url) || asString(data.url)
  const asciiMode = qrNeedsAscii()
  return {
    ticket,
    ascii: await qrAscii(url, asciiMode),
    htmlPath: asString(data.qr_html) || asString(data.qrHtml),
    url,
    asciiMode,
  }
}

export type YoukuQRPoll = {
  sign: string
  loggedIn: boolean
}

export async function pollYoukuQR(cli: GwClient, ticket: string): Promise<YoukuQRPoll> {
  const data = await cli.invoke('youku', 'login', { method: 'qr', state: 'check', yk_ticket: ticket })
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
