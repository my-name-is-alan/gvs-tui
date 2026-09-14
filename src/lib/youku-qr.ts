import QRCode from 'qrcode'
import type { GwClient } from './client.ts'
import { asString } from './util.ts'

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

export async function startYoukuQR(cli: GwClient): Promise<{ ticket: string; ascii: string }> {
  const data = await cli.invoke('youku', 'login', { method: 'qr', force: '1' })
  const ticket = asString(data.yk_ticket) || asString(data.ticket)
  const url = asString(data.qrCodeUrl) || asString(data.qr_url) || asString(data.url)
  return { ticket, ascii: await qrAscii(url) }
}

export async function pollYoukuQR(cli: GwClient, ticket: string): Promise<string> {
  try {
    const data = await cli.invoke('youku', 'login', { method: 'qr', state: 'check', yk_ticket: ticket })
    return asString(data.yk_sign) || asString(data.sign)
  } catch {
    return ''
  }
}

export async function importYoukuCookie(cli: GwClient, cookie: string): Promise<string> {
  const data = await cli.invoke('youku', 'login', { method: 'cookie', cookie })
  const sign = asString(data.yk_sign) || asString(data.sign)
  if (!sign) throw new Error('没有 yk_sign，Cookie 可能缺 P_sck')
  return sign
}
