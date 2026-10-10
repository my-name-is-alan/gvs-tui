import { isLocalGateway } from '../../../src/lib/gateway-route.ts'

/** A desktop override is an HTTP(S) proxy endpoint, never a PAC URL. */
export function normalizeDesktopProxy(value: string): string {
  if (typeof value !== 'string') throw new Error('代理地址应为 HTTP/HTTPS 地址；留空使用系统代理')
  const input = value.trim()
  if (!input) return ''
  try {
    const url = new URL(input)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid proxy')
    return url.href.replace(/\/$/, '')
  } catch {
    throw new Error('请填写不含账号密码的 HTTP/HTTPS 代理地址和端口；不要填写 PAC 文件地址。留空使用系统代理。')
  }
}

/** Keep the WebSocket route aligned with the selected service proxy. */
export async function resolveDesktopTunnelProxy(
  url: string,
  configured: string,
  inherited: string,
  resolveSystem: (url: string) => Promise<string>,
): Promise<string> {
  if (isLocalGateway(url)) return ''
  if (configured) return configured
  if (inherited) return inherited
  try {
    const rule = await resolveSystem(url)
    const match = /^\s*(PROXY|HTTPS)\s+([^\s;]+)/i.exec(rule)
    if (match) return `${match[1]!.toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${match[2]}`
  } catch {
    // Preserve the existing default route when system proxy resolution is unavailable.
  }
  return ''
}
