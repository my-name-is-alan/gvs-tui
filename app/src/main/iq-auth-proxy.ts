type Fetcher = (url: string, init: RequestInit) => Promise<Response>
type IQAuthNetwork = {
  fetch: (url: string, init: RequestInit, proxy: string) => Promise<Response>
  resolveProxy: (url: string) => Promise<string>
  configuredProxy?: () => string
  log: (line: string) => void
}

const AUTH_HOSTS = new Set(['passport.iq.com', 'intl-passport.iqiyi.com'])
const SOURCE_SUFFIXES = ['iq.com', 'inter.iqiyi.com', 'video.iqiyi.com']

/** Account endpoints only; media and other providers keep their own transport. */
export function isIQAuthURL(url: URL): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && AUTH_HOSTS.has(url.hostname)
}

/** Match the IQ overseas rules before the tunnel's direct/fake-IP transport. */
export function isIQSourceURL(url: URL): boolean {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
  return AUTH_HOSTS.has(url.hostname)
    || SOURCE_SUFFIXES.some(host => url.hostname === host || url.hostname.endsWith('.' + host))
}

export function createIQSourceRoute(network: IQAuthNetwork): (url: URL) => Promise<Fetcher | undefined> {
  return async url => {
    if (!isIQSourceURL(url)) return undefined
    const label = isIQAuthURL(url) ? 'iq_auth_transport' : 'iq_source_transport'
    let proxy = network.configuredProxy?.() ?? ''
    const route = proxy ? 'configured-proxy' : 'system-proxy'
    if (!proxy) {
      const policy = await network.resolveProxy(url.href)
      // Respect the first PAC decision. DIRECT retains the tunnel's fake-IP-safe transport.
      if (/^\s*DIRECT(?:\s*;|\s*$)/i.test(policy)) {
        network.log(`${label} host=${url.hostname} route=direct`)
        return undefined
      }
      const match = /^\s*(PROXY|HTTPS)\s+([^\s;]+)/i.exec(policy)
      if (!match) throw new Error('IQ 请求的系统代理类型不支持，请使用 HTTP/HTTPS 系统代理')
      proxy = `${match[1]!.toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${match[2]}`
    }
    return async (input, init) => {
      // Log routing and HTTP status, never paths, queries, credentials or bodies.
      network.log(`${label} host=${url.hostname} route=${route}`)
      try {
        const response = await network.fetch(input, { ...init, credentials: 'omit', cache: 'no-store' }, proxy)
        network.log(`${label} host=${url.hostname} route=${route} http=${response.status}`)
        return response
      } catch (error) {
        network.log(`${label} host=${url.hostname} route=${route} failed`)
        throw error
      }
    }
  }
}
