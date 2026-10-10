import { net, session, type Session } from 'electron'
import { createHash } from 'node:crypto'
import { isLocalGateway } from '../../../src/lib/gateway-route.ts'
import { normalizeDesktopProxy } from './desktop-proxy'

let configuredProxy = ''
const proxySessions = new Map<string, Promise<Session>>()

export function desktopProxy(): string { return configuredProxy }

export function setDesktopProxy(value: string): void {
  configuredProxy = normalizeDesktopProxy(value)
}

function serviceSession(proxy: string): Promise<Session> {
  const existing = proxySessions.get(proxy)
  if (existing) return existing
  const ready = (async () => {
    // A separate in-memory session leaves media downloads and system/PAC routing untouched.
    const id = createHash('sha256').update(proxy).digest('hex')
    const target = session.fromPartition(`gvs-services-${id}`, { cache: false })
    await target.setProxy(proxy
      ? { mode: 'fixed_servers', proxyRules: proxy }
      : { mode: 'direct' })
    return target
  })()
  proxySessions.set(proxy, ready)
  void ready.catch(() => { if (proxySessions.get(proxy) === ready) proxySessions.delete(proxy) })
  return ready
}

/** Gateway and TMDB override only; an unavailable explicit proxy never retries direct. */
export async function fetchDesktopService(url: string, init: RequestInit = {}): Promise<Response> {
  const proxy = configuredProxy
  if (!proxy) return net.fetch(url, init)
  const local = isLocalGateway(url)
  try {
    const target = await serviceSession(local ? '' : proxy)
    return await target.fetch(url, { ...init, credentials: init.credentials ?? 'omit' })
  } catch (error) {
    if (local || init.signal?.aborted
      || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) throw error
    throw new Error('无法通过代理连接，请检查代理是否运行、地址和端口是否正确（设置 → 网关 → 代理地址）')
  }
}
