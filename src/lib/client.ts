import { truncate } from './util.ts'
import type { FileConfig } from './config.ts'

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
  ): Promise<Record<string, unknown>> {
    const env = await this.request('POST', '/v1/invoke', { provider, action, input }, extra)
    return (env.data ?? {}) as Record<string, unknown>
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
  ): Promise<Envelope> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.key}` }
    let payload: string | undefined
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    if (extra) Object.assign(headers, extra)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 45_000)
    let res: Response
    try {
      res = await fetch(`${this.host}${path}`, { method, headers, body: payload, signal: ac.signal })
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
  if (/tui tunnel offline/i.test(msg)) return '隧道未连接（优酷/腾讯需要家宽出口）'
  switch (msg) {
    case 'IP_LIMITED':
      return '这把 Key 10 分钟内已在 2 个 IP 用过'
    default:
      return msg
  }
}
