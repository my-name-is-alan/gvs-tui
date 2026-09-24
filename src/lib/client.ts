import { truncate } from './util.ts'
import type { FileConfig } from './config.ts'
import { fetchRemote } from './proxy.ts'
import { runLog, summarizeInput, summarizeResult } from './runlog.ts'
export type KeyInfo = {
  id: string
  name: string
  prefix: string
  scope: string[]
  all: boolean
  qps: number
  daily: number
  usedToday: number
  expiresAt: string | null
  permanent: boolean
  daysLeft: number | null
}

type Envelope = { code: number; msg: string; data: unknown }

/** 优酷登录态失效（本地 Yk-Sign 过期或被踢）。调用方应清掉本地签名并引导重新扫码。 */
export class ReloginRequired extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReloginRequired'
  }
}

const RELOGIN_RE = /requires re-login|needs_relogin|invalid Yk-Sign/i

/** Default invoke abort; Tencent catalog play (source+caption) often exceeds 45s. */
const DEFAULT_TIMEOUT_MS = 45_000
const TENCENT_PLAY_TIMEOUT_MS = 120_000

export class GwClient {
  host: string
  key: string

  constructor(host: string, key: string) {
    this.host = host.replace(/\/+$/, '')
    this.key = key
  }

  allows(scope: string[] | undefined, all: boolean, name: string): boolean {
    if (all) return true
    if (!scope || scope.length === 0) return false
    return scope.includes(name)
  }

  /** 请求头。`skipSign` 只影响这一次调用 —— 不要为了降级去改用户的配置文件。 */
  extra(cfg: FileConfig, provider: string, skipSign = false): Record<string, string> {
    const h: Record<string, string> = {}
    if (provider === 'youku' && cfg.youkuSign && !skipSign) h['Yk-Sign'] = cfg.youkuSign
    if (provider === 'tencent' && (!cfg.tencentMode || cfg.tencentMode === 'cookie') && cfg.tencentCookie) h['Tx-Cookie'] = cfg.tencentCookie
    return h
  }

  async invoke(
    provider: string,
    action: string,
    input: Record<string, unknown>,
    extra?: Record<string, string>,
    opts?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    const timeoutMs =
      opts?.timeoutMs ??
      (provider === 'tencent' && action === 'play' ? TENCENT_PLAY_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)
    const t0 = Date.now()
    const headerNote = extra
      ? Object.keys(extra)
          .map((k) => (/yk-sign|tx-cookie|cookie|authorization|token/i.test(k) ? `${k}=***` : k))
          .join(',')
      : ''
    try {
      const env = await this.request(
        'POST',
        '/v1/invoke',
        { provider, action, input },
        extra,
        timeoutMs,
      )
      const data = (env.data ?? {}) as Record<string, unknown>
      runLog(
        `invoke ${provider}/${action} ${summarizeInput(input)}${headerNote ? ` hdr=${headerNote}` : ''} ${Date.now() - t0}ms ok ${summarizeResult({ ...data, code: env.code, msg: env.msg })}`,
      )
      return data
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      runLog(
        `invoke ${provider}/${action} ${summarizeInput(input)}${headerNote ? ` hdr=${headerNote}` : ''} ${Date.now() - t0}ms fail ${truncate(msg, 160)}`,
      )
      throw e
    }
  }

  async keyInfo(): Promise<KeyInfo> {
    const env = await this.request('GET', '/v1/key')
    return (env.data ?? {}) as KeyInfo
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    extra?: Record<string, string>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Envelope> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.key}` }
    let payload: string | undefined
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    if (extra) Object.assign(headers, extra)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetchRemote(`${this.host}${path}`, { method, headers, body: payload, signal: ac.signal })
    } finally {
      clearTimeout(timer)
    }
    const text = await res.text()
    let env: Envelope
    try {
      env = JSON.parse(text) as Envelope
    } catch {
      throw new Error(`http ${res.status}: ${truncate(text, 180)}`)
    }
    if (env.code !== 0) {
      const message = limitError(env.msg) || `http ${res.status}`
      throw RELOGIN_RE.test(message) ? new ReloginRequired(message) : new Error(message)
    }
    return env
  }
}

function limitError(msg: string): string {
  if (/tui tunnel offline/i.test(msg)) return '隧道未连接（优酷/腾讯/黄果需要家宽出口）'
  switch (msg) {
    case 'IP_LIMITED':
      return '这把 Key 10 分钟内已在 2 个 IP 用过'
    default:
      return msg
  }
}
