// 桌面端替身：tui/src/lib/proxy.ts
// 网关 / TMDB 走 Chromium 网络栈（net.fetch），自动跟随系统代理（Clash 等）；
// CDN 与上游仍用 Node fetch 直连，从本机 IP 出网。
import { net } from 'electron'

const PROXY_KEYS: Record<string, true> = { http_proxy: true, https_proxy: true, all_proxy: true }

export function isProxyEnvKey(key: string): boolean {
  return PROXY_KEYS[key.toLowerCase()] === true
}

export function normalizeHttpProxy(value: string): string {
  const proxy = value.trim()
  if (!proxy) return ''
  try {
    const url = new URL(proxy)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid proxy')
    return url.href.replace(/\/$/, '')
  } catch {
    throw new Error('请填写 HTTP/HTTPS 代理地址，如 http://127.0.0.1:7897；留空使用默认网络')
  }
}

export function inheritedProxyUrl(env: NodeJS.Dict<string> = process.env): string {
  if (env.GVS_PROXY?.trim()) return ''
  for (const [k, v] of Object.entries(env)) {
    if (!v?.trim() || !isProxyEnvKey(k)) continue
    return v.trim()
  }
  return ''
}

export function envWithoutProxy(env: NodeJS.Dict<string> = process.env, proxy: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || isProxyEnvKey(k)) continue
    out[k] = v
  }
  out.GVS_PROXY = proxy
  return out
}

export async function fetchRemote(url: string, init: RequestInit = {}): Promise<Response> {
  return net.fetch(url, init as Parameters<typeof net.fetch>[1])
}

/** Like desktop TMDB search, use Chromium's system proxy rather than Bun options. */
export function fetchTmdb(url: string, init: RequestInit & { proxy?: string } = {}): Promise<Response> {
  return fetchRemote(url, init)
}

/** 桌面端网关请求走系统代理。tui.json 里的 gatewayProxy 只给终端版用。 */
export async function fetchGateway(url: string, init: RequestInit, _savedProxy = ''): Promise<Response> {
  return net.fetch(url, init as Parameters<typeof net.fetch>[1])
}

export async function reexecWithoutProxy(): Promise<void> {}
