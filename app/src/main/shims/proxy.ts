// 桌面端替身：tui/src/lib/proxy.ts
// 网关 / TMDB 走 Chromium 网络栈（net.fetch），自动跟随系统代理（Clash 等）；
// CDN 与上游仍用 Node fetch 直连，从本机 IP 出网。
import { net } from 'electron'

const PROXY_KEYS: Record<string, true> = { http_proxy: true, https_proxy: true, all_proxy: true }

export function isProxyEnvKey(key: string): boolean {
  return PROXY_KEYS[key.toLowerCase()] === true
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

export async function reexecWithoutProxy(): Promise<void> {}
