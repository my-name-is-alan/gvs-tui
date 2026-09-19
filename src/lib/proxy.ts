/** Bun caches HTTP(S)_PROXY at process start. Runtime delete / per-request
 * `{ proxy: '' }` cannot undo that, so CDN fetch keeps going through Clash.
 * Strip the env and re-exec once; keep the original URL in GVS_PROXY for
 * gateway/TMDB only. */

const PROXY_KEYS: Record<string, true> = {
  http_proxy: true,
  https_proxy: true,
  all_proxy: true,
}

export function isProxyEnvKey(key: string): boolean {
  return PROXY_KEYS[key.toLowerCase()] === true
}

/** Empty when already re-exec'd (`GVS_PROXY`) or no proxy env is set. */
export function inheritedProxyUrl(env: NodeJS.Dict<string> = process.env): string {
  if (env.GVS_PROXY?.trim()) return ''
  for (const [k, v] of Object.entries(env)) {
    if (!v?.trim() || !isProxyEnvKey(k)) continue
    return v.trim()
  }
  return ''
}

export function envWithoutProxy(
  env: NodeJS.Dict<string> = process.env,
  proxy: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || isProxyEnvKey(k)) continue
    out[k] = v
  }
  out.GVS_PROXY = proxy
  return out
}

/** Gateway / TMDB: explicit proxy, fall back to direct. CDN must not call this. */
export async function fetchRemote(url: string, init: RequestInit = {}): Promise<Response> {
  const proxy = process.env.GVS_PROXY?.trim() ?? ''
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    /* treat as remote */
  }
  if (!proxy || host === '127.0.0.1' || host === 'localhost' || host === '::1') return fetch(url, init)
  try {
    return await fetch(url, { ...init, proxy } as RequestInit & { proxy: string })
  } catch (e) {
    if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw e
    return fetch(url, init)
  }
}

/** Returns after a no-op. Re-exec path never returns: it exits with the child. */
export async function reexecWithoutProxy(): Promise<void> {
  const found = inheritedProxyUrl()
  if (!found) return
  const child = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
    env: envWithoutProxy(process.env, found),
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  process.exit((await child.exited) ?? 0)
}
