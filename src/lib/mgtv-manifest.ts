import { fetchMediaProbe } from './proxy'
import { runLog } from './runlog'
import { sleep } from './util.ts'

type ManifestResult = { url: string; durationSeconds: number; segmentCount: number }

const STRIPPED_HEADERS = new Set(['user-agent', 'referer'])
/** 非浏览器 UA：实测芒果对 Mozilla/Chrome 之外的 UA 一律放行。 */
export const MgtvUserAgent = 'gvs/1.0'

/**
 * 芒果清单与分片的签名都在 URL 里（`...m3u8?arange=0&pm=...`），
 * **不需要 UA、也不需要 Referer**。实测（同一分集各 3 次）：
 *   IP 直连节点 219.154.x.x：带 Chrome UA → 405，不带 → 200
 *   域名节点 pcvideo*：带 Referer → 403，不带 → 200
 * 所以默认不带这两个头，其它（Accept / 网关给的 token 等）原样保留。
 */
export function mgtvRequestHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const kept = Object.fromEntries(Object.entries(headers).filter(([name]) => !STRIPPED_HEADERS.has(name.toLowerCase())))
  // 浏览器 UA（Mozilla/…Chrome）会被拒，非浏览器串（curl/8.7.1、gvs/1.0、空值）全通；
  // Electron 的 fetch 会自带 Mozilla UA，所以这里显式换掉，不能只是"不设置"。
  kept['User-Agent'] = MgtvUserAgent
  return kept
}

/**
 * 芒果 IP:直连节点整段时间回 405，域名节点（pcvideo*.titan.mgtv.com）会回 403，
 * 都属于"这个节点现在不给"，换节点/稍后再说就能过，因此按可重试处理。
 */
export function mgtvRetryableStatus(status: number | undefined): boolean {
  return status === 403 || status === 405 || status === 408 || status === 429 || (status !== undefined && status >= 500)
}

/** Ignore missing, boolean and malformed duration fields; preserve fractional seconds. */
export function mgtvExpectedDuration(...values: unknown[]): number | undefined {
  const seconds = values.map(value => {
    if (typeof value !== 'number' && typeof value !== 'string') return 0
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  })
  return Math.max(...seconds) || undefined
}

export function mgtvDurationCovers(actual: number, expected: number): boolean {
  if (!Number.isFinite(expected) || expected <= 0) return false
  // Keep the existing long-program allowance; short clips need a smaller one.
  const tolerance = expected > 30 ? Math.max(10, expected * .05) : Math.max(.25, expected * .05)
  return Number.isFinite(actual) && actual > 0 && actual >= expected - tolerance
}

function validURL(raw: string, base?: string): string {
  const url = new URL(raw, base)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('芒果播放清单地址无效')
  return url.href
}

/**
 * Checks the local HLS playlist before a mgtv download. The gateway's
 * top-level `preview` flag is not reliable on the TV endpoint, so the
 * playlist duration must also cover a positive expected program duration.
 * Return the checked media URL so the downloader uses this exact playlist.
 */
export async function verifyMgtvManifest(
  raw: string,
  headers: Record<string, string>,
  expectedDuration: number | undefined,
  signal?: AbortSignal,
): Promise<ManifestResult> {
  signal?.throwIfAborted()
  const expected = mgtvExpectedDuration(expectedDuration)
  if (expected === undefined) throw new Error('芒果未提供有效整集时长，无法确认完整内容；请刷新分集或取流后重试')
  let url = validURL(raw)
  const visited = new Set<string>()
  for (let depth = 0; depth < 4; depth++) {
    signal?.throwIfAborted()
    if (visited.has(url)) throw new Error('芒果播放清单重复，无法确认完整内容')
    visited.add(url)
    // 芒果 IP 直连节点会随机对同一个清单地址回 405（实测同一 URL 连续请求在 200/405 之间跳），
    // 单次读取失败率约一半，所以这里对 405/408/429/5xx 做几次短重试再放弃。
    const attempts = 4
    let response: Response | undefined
    let text = ''
    for (let attempt = 1; ; attempt++) {
      const timeout = AbortSignal.timeout(20_000)
      const readSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
      let httpStatus: number | undefined
      // 优先不带 UA/Referer；仍被拒时才带上原本的头试一次（个别节点策略相反）。
      const attemptHeaders = attempt === 2 || attempt === 4 ? headers : mgtvRequestHeaders(headers)
      try {
        response = await fetchMediaProbe(url, { headers: attemptHeaders, signal: readSignal })
        httpStatus = response.status
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => {})
          throw new Error(`HTTP ${response.status}`)
        }
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > 1024 * 1024) throw new Error('芒果播放清单过大，无法确认完整内容')
            chunks.push(value)
          }
        } finally { await reader.cancel().catch(() => {}) }
        text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
        break
      } catch (error) {
        signal?.throwIfAborted()
        if (error instanceof Error && error.message.startsWith('芒果播放清单过大')) throw error
        const rejected = httpStatus !== undefined && (httpStatus < 200 || httpStatus >= 300)
        const retryable = mgtvRetryableStatus(httpStatus)
        if (retryable && attempt < attempts) {
          // Host and status only: never the signed path, query or headers.
          runLog(`mgtv manifest retry host=${new URL(url).host} http=${httpStatus} attempt=${attempt}/${attempts} ua=${attempt === 2 || attempt === 4 ? 'yes' : 'no'}`)
          await sleep(attempt === 1 ? 700 : attempt === 2 ? 1500 : 2500, signal)
          continue
        }
        const reason = rejected ? `http_${httpStatus}` : readSignal.aborted ? 'timeout' : 'network'
        runLog(`mgtv manifest read failed host=${new URL(url).host} http=${httpStatus ?? '-'} reason=${reason}`)
        throw new Error(`芒果播放清单读取失败${rejected ? `（HTTP ${httpStatus}）` : ''}，无法确认完整内容；请刷新画质后重试`, { cause: error })
      }
    }
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    if (lines[0] !== '#EXTM3U') throw new Error('芒果返回的内容不是有效播放清单')
    const variant = lines.findIndex(line => line.startsWith('#EXT-X-STREAM-INF:'))
    if (variant >= 0) {
      if (lines.filter(line => line.startsWith('#EXT-X-STREAM-INF:')).length !== 1) throw new Error('芒果主清单包含多个版本，无法确认所选画质；请重新取流')
      const child = lines[variant + 1]
      if (!child || child.startsWith('#')) throw new Error('芒果主清单缺少媒体版本')
      url = validURL(child, response?.url || url)
      continue
    }
    const durations: number[] = []
    let pending: number | undefined
    for (const line of lines) {
      if (line.startsWith('#EXTINF:')) {
        if (pending !== undefined) throw new Error('芒果播放清单分段缺少地址')
        const duration = line.slice(8).split(',')[0]!.trim()
        const seconds = /^\d+(?:\.\d+)?$/.test(duration) ? Number(duration) : NaN
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('芒果播放清单含无效分段时长')
        pending = seconds
      } else if (!line.startsWith('#')) {
        if (pending === undefined) throw new Error('芒果播放清单分段缺少时长')
        validURL(line, response.url || url)
        durations.push(pending)
        pending = undefined
      }
    }
    if (pending !== undefined || !durations.length) throw new Error('芒果播放清单缺少媒体分段')
    if (!lines.includes('#EXT-X-ENDLIST')) throw new Error('芒果播放清单尚未结束，可能是试看')
    const durationSeconds = durations.reduce((sum, seconds) => sum + seconds, 0)
    if (!mgtvDurationCovers(durationSeconds, expected)) {
      throw new Error('芒果播放清单明显短于整集时长，可能是试看')
    }
    return { url: validURL(response?.url || url), durationSeconds, segmentCount: durations.length }
  }
  throw new Error('芒果播放清单嵌套过深，无法确认完整内容')
}
