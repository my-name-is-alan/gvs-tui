// 桌面端替身：tui/src/lib/proxy.ts
// 网关 / TMDB 走 Chromium 网络栈，优先桌面代理配置，留空跟随系统代理（Clash 等）；
// CDN 与默认上游用 Node fetch 直连；IQ 海外版登录/取流接口的系统代理例外在 env.ts 注册。
// 咪咕媒体清单保留 Referer/UA，以 Node HTTP 读取，并按系统/PAC 代理路由。
import { session } from 'electron'
import { fetchDesktopService } from '../desktop-network'
import { fetchNativeMediaProbe, fetchNativeMediaSegment } from '../media-probe-transport'

/** Probe through the same system proxy used by the native media downloader. */
export function fetchMediaProbe(url: string, init: RequestInit): Promise<Response> {
  return fetchNativeMediaProbe(url, init, target => session.defaultSession.resolveProxy(target))
}

/** Stream IQ media without the manifest size cap; preserve the same CDN headers and route. */
export function fetchMediaSegment(url: string, init: RequestInit): Promise<Response> {
  return fetchNativeMediaSegment(url, init, target => session.defaultSession.resolveProxy(target))
}

/** Side media files (CR subtitles) ride the same native route; the explicit proxy is unused here. */
export function fetchMediaPart(url: string, init: RequestInit, _proxy = ''): Promise<Response> {
  return fetchNativeMediaSegment(url, init, target => session.defaultSession.resolveProxy(target))
}

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
  return fetchDesktopService(url, init)
}

/** TMDB shares the desktop service route, independent of TUI-only proxy options. */
export function fetchTmdb(url: string, init: RequestInit & { proxy?: string } = {}): Promise<Response> {
  const { proxy: _tuiProxy, ...request } = init
  return fetchRemote(url, request)
}

/** gatewayProxy remains TUI-only; desktopProxy controls desktop service requests. */
export async function fetchGateway(url: string, init: RequestInit, _savedProxy = ''): Promise<Response> {
  return fetchDesktopService(url, init)
}

export async function reexecWithoutProxy(): Promise<void> {}
