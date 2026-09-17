import { spawn } from 'node:child_process'
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
/** Win10 1809 conhost / GBK PowerShell: no █▀▄, and █ is 2 cells so the code shears. */
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

export function renderQr(url: string, mode: 'ascii' | 'compact'): string {
  if (!url) return ''
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' })
  const n = qr.modules.size
  const dim = n + QZ * 2
  const dark = (x: number, y: number) => {
    const mx = x - QZ
    const my = y - QZ
    return mx >= 0 && my >= 0 && mx < n && my < n && qr.modules.get(mx, my)
  }
  const lines: string[] = []
  if (mode === 'ascii') {
    for (let y = 0; y < dim; y++) {
      let line = ''
      for (let x = 0; x < dim; x++) line += dark(x, y) ? '##' : '  '
      lines.push(line)
    }
    return lines.join('\n')
  }
  for (let y = 0; y < dim; y += 2) {
    let line = ''
    for (let x = 0; x < dim; x++) {
      const top = dark(x, y)
      const bot = y + 1 < dim && dark(x, y + 1)
      line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' '
    }
    lines.push(line)
  }
  return lines.join('\n')
}

export async function qrAscii(url: string, ascii = qrNeedsAscii()): Promise<string> {
  if (!url) return ''
  return renderQr(url, ascii ? 'ascii' : 'compact')
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

/** Open the generated PNG through the default Windows image viewer. */
export async function openQrPng(
  file: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform !== 'win32' || !file) return false
  try {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '', resolve(file)], {
      windowsHide: true,
      stdio: 'ignore',
    })
    return await new Promise<boolean>((done) => {
      let settled = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        done(ok)
      }
      child.once('error', () => finish(false))
      child.once('close', (code) => finish(code === 0))
    })
  } catch {
    return false
  }
}

export type YoukuQRStart = {
  ticket: string
  loginToken: string
  ascii: string
  pngPaths: string[]
  imageOpened: boolean
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
  const imageOpened = await openQrPng(pngPaths[0] ?? '')
  // Classic Win10 conhost cannot reliably display Unicode or double-width QR output.
  const ascii = qrNeedsAscii() && pngPaths.length ? '' : await qrAscii(url)
  return { ticket, loginToken, ascii, pngPaths, imageOpened }
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
