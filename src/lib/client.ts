import type { DRMFileStatus, DRMStatus, DRMSystem, PlatformMetaResponse } from './drm-types.ts'
import { truncate } from './util.ts'
import type { FileConfig } from './config.ts'
import { fetchGateway } from './proxy.ts'
import { runLog, summarizeInput, summarizeResult } from './runlog.ts'
import { bindMobile42PlayInput } from './tencent-mobile42.ts'
import { TencentOperations, type TencentOperation } from './tencent-operations.ts'
import { TencentNativeEvents } from './tencent-native-events.ts'
import { defaultTencentNativeEventPath, feedTencentNativeFixtures, resolveNativeCollectMode } from './tencent-native-fixture-feed.ts'
import { randomUUID } from 'node:crypto'
import { normalizeIQCookie } from './iq.ts'
import { tencentRisk, TencentRiskStop } from './tencent-risk.ts'
import { writeTencentDiagnostic } from './tencent-diagnostics.ts'
import { userMessage } from './user-message.ts'
import { retryAfterMillis } from './iqcn-control.ts'
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

type Envelope = { code: number; msg: string; data: unknown; error_code?: string; request_id?: unknown; diagnostics?: unknown }

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

export const GW_ACCOUNT_HEADER = 'X-Gvs-Account'
export const GW_DEFAULT_ACCOUNT = 'default'
export type GatewayAccountsInfo = { multiAccount: true; providers: string[]; header: string }

/** 本地账号槽位 id → 网关账号 id（^[a-z0-9][a-z0-9_-]{0,31}$） */
export function gatewayAccountId(slotId: string): string {
  let id = slotId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '')
  if (id.length > 32) id = id.slice(0, 20) + '-' + hashTail(slotId)
  if (!id || id === GW_DEFAULT_ACCOUNT) id = 'a' + hashTail(slotId)
  return id
}
function hashTail(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36)
}

export { DRM_MAX_BYTES, type DRMFileStatus, type DRMStatus, type DRMSystem } from './drm-types.ts'

export class GwClient {
  host: string
  key: string
  /** 读当前配置；给抖音请求自动带上 Dy-Cookie（调用方不用逐处传 extra）。 */
  private cfgOf?: () => FileConfig | undefined
  private proxyOf: () => string | undefined = () => undefined
  private operations?: TencentOperations
  private operationScope = ''
  private nativeEvents?: TencentNativeEvents
  private nativeEventFileOverride?: string
  private diagnosticJobID = ''
  private readonly source: 'tui_process' | 'electron_process'
  /**
   * 多账号网关（/v1/accounts multiAccount=true）：返回这次请求要用的网关账号 id。
   * 空 / 'default' = 旧行为（网关按 Key 的默认会话）。旧网关从不设置。
   */
  accountFor?: (provider: string) => string | undefined

  constructor(host: string, key: string, cfgOf?: (() => FileConfig | string | undefined) | string, source: 'tui_process' | 'electron_process' = 'tui_process') {
    this.host = host.replace(/\/+$/, '')
    this.key = key
    this.source = source
    if (typeof cfgOf !== 'function') {
      const fixed = cfgOf ?? ''
      this.proxyOf = () => fixed
      return
    }
    this.cfgOf = () => {
      const value = cfgOf()
      return value && typeof value === 'object' ? value : undefined
    }
    this.proxyOf = () => {
      const value = cfgOf()
      if (typeof value === 'string') return value
      return value?.gatewayProxy
    }
  }

  private nativeEventSettings() {
    const cfg = this.cfgOf?.()
    // External captures and replay templates belong to explicit research runs.
    // Persisted settings from older releases must not arm them in the App.
    const collect = process.env.GVS_TENCENT_NATIVE_RESEARCH === '1' ? resolveNativeCollectMode(cfg || {}) : 'off'
    const configured = this.nativeEventFileOverride ?? (cfg?.tencentNativeEventFile?.trim() || '')
    const path = collect === 'off' ? '' : collect === 'fixture' ? (configured || defaultTencentNativeEventPath()) : configured
    return {
      path,
      mode: (collect === 'off' ? 'off' : collect === 'fixture' ? 'preview' : (cfg?.tencentNativeEventMode ?? 'preview')) as 'off' | 'preview' | 'send',
      collect,
      gateway: this.host,
      account: this.accountFor?.('tencent') || GW_DEFAULT_ACCOUNT,
      deviceGuid: cfg?.tencentTVDevice?.trim() || '',
    }
  }

  private feedFixtureProducer(): void {
    const settings = this.nativeEventSettings()
    if (settings.collect !== 'fixture' || settings.mode === 'off' || !settings.path) return
    if (!settings.deviceGuid) {
      runLog('tencent_native_event status=fixture_device_missing')
      return
    }
    try {
      const result = feedTencentNativeFixtures({
        gateway: settings.gateway,
        account: settings.account,
        deviceGuid: settings.deviceGuid,
        outPath: settings.path,
        delivery: 'pending',
      })
      runLog(`tencent_native_event status=fixture_fed written=${result.written} kinds=${result.kinds.join(',')}`)
    } catch {
      runLog('tencent_native_event status=fixture_feed_failed')
    }
  }

  private tencentReportsEnabled(): boolean {
    // Automatic for both clients, including configurations saved with the old
    // opt-in toggle disabled. The environment override is for support runs.
    return process.env.GVS_TENCENT_OBSERVE !== '0'
  }

  private async tencentReport(input: Record<string, unknown>, account = this.accountFor?.('tencent')): Promise<Record<string, unknown>> {
    const extra = account && account !== GW_DEFAULT_ACCOUNT ? { [GW_ACCOUNT_HEADER]: account } : undefined
    const envelope = await this.request('POST', '/v1/invoke', { provider: 'tencent', action: 'report', input }, extra, input.report_type === 'event' ? 10_000 : 2_000)
    return (envelope.data ?? {}) as Record<string, unknown>
  }

  private operationTracker(): TencentOperations {
    const scope = `${this.host}\0${this.key}\0${this.accountFor?.('tencent') || GW_DEFAULT_ACCOUNT}\0${this.nativeEventSettings().path}`
    if (!this.operations || this.operationScope !== scope) {
      this.operationScope = scope
      const owner = this.nativeEventSettings()
      const diagnosticScope = `${this.host}\0${this.key}`
      this.nativeEvents = new TencentNativeEvents(() => ({ ...this.nativeEventSettings(), gateway: owner.gateway, account: owner.account, path: owner.path }), runLog,
        (kind, id, reply) => writeTencentDiagnostic(diagnosticScope, { flow: '', operation: id, job: this.diagnosticJobID, action: kind, phase: 'native',
          status: String(reply.status || 'unknown'), decision: reply.stop === true || reply.delivery_unknown === true ? 'no_automatic_resend' : 'not_acceptance_proof' }))
      const native = this.nativeEvents
      this.operations = new TencentOperations(input => this.tencentReport(input, owner.account), runLog, this.diagnosticJobID, undefined, `${this.host}\0${this.key}`, this.source,
        (binding, call) => { this.feedFixtureProducer(); return native.drain(binding, call) })
    }
    return this.operations
  }

  forkTencentJob(jobID: number, vid: string): GwClient {
    const child = new GwClient(this.host, this.key, this.cfgOf, this.source)
    child.proxyOf = this.proxyOf
    child.diagnosticJobID = String(jobID)
    const accountFor = this.accountFor
    const tencentAccount = accountFor?.('tencent')
    child.accountFor = provider => provider === 'tencent' ? tencentAccount : accountFor?.(provider)
    if (!this.tencentReportsEnabled()) return child
    child.nativeEventFileOverride = this.nativeEventSettings().path
    child.operations = this.operationTracker().fork(String(jobID), vid, input => child.tencentReport(input, tencentAccount || GW_DEFAULT_ACCOUNT))
    child.nativeEvents = this.nativeEvents
    child.operationScope = `${child.host}\0${child.key}\0${tencentAccount || GW_DEFAULT_ACCOUNT}\0${child.nativeEventSettings().path}`
    return child
  }

  /** 固定某平台用某个网关账号（下载任务入队时锁定，之后切换「当前账号」不影响它） */
  fixedAccount(provider: string, account: string | undefined): GwClient {
    if (!account || account === GW_DEFAULT_ACCOUNT) {
      if (!this.accountFor?.(provider)) return this
    }
    const child = new GwClient(this.host, this.key, this.cfgOf, this.source)
    child.proxyOf = this.proxyOf
    child.diagnosticJobID = this.diagnosticJobID
    const parent = this.accountFor
    child.accountFor = (p) => (p === provider ? account || GW_DEFAULT_ACCOUNT : parent?.(p))
    return child
  }

  /** 网关多账号能力；旧网关（没有 /v1/accounts）返回 null */
  async accountsInfo(): Promise<GatewayAccountsInfo | null> {
    try {
      const env = await this.request('GET', '/v1/accounts', undefined, undefined, 10_000)
      const d = (env.data ?? {}) as Partial<GatewayAccountsInfo>
      if (d.multiAccount !== true || !Array.isArray(d.providers)) return null
      return { multiAccount: true, providers: d.providers.filter((x): x is string => typeof x === 'string'), header: typeof d.header === 'string' ? d.header : GW_ACCOUNT_HEADER }
    } catch {
      return null
    }
  }

  /** 在网关登记账号；已存在算成功 */
  async ensureAccount(provider: string, id: string, name: string): Promise<void> {
    try {
      await this.request('POST', '/v1/accounts', { provider, id, name: name.slice(0, 64) }, undefined, 10_000)
    } catch (e) {
      if ((e as { httpStatus?: number }).httpStatus === 409 && !/LIMIT/i.test(String((e as Error).message))) return
      throw e
    }
  }

  async renameAccount(provider: string, id: string, name: string): Promise<void> {
    await this.request('PATCH', `/v1/accounts/${encodeURIComponent(id)}`, { provider, name: name.slice(0, 64) }, undefined, 10_000)
  }

  /** 网关会先注销这个账号的平台会话再删除登记 */
  async deleteAccount(provider: string, id: string): Promise<void> {
    try {
      await this.request('DELETE', `/v1/accounts/${encodeURIComponent(id)}?provider=${encodeURIComponent(provider)}`, undefined, undefined, 20_000)
    } catch (e) {
      if ((e as { httpStatus?: number }).httpStatus === 404) return
      throw e
    }
  }

  observeTencentTransfer(bytes: number, total: number): void { this.operations?.observeTransfer(bytes, total) }
  async closeTencentTransfer(cancelled = false, failed = false): Promise<void> { await this.operations?.closeTransfer(cancelled, failed) }

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
    if (provider === 'douyin' && cfg.douyinCookie) h['Dy-Cookie'] = cfg.douyinCookie
    if (provider === 'iq' && cfg.iqCookie) h['Iq-Cookie'] = normalizeIQCookie(cfg.iqCookie)
    if (provider === 'iq' && cfg.iqProfile) h['Iq-Profile'] = cfg.iqProfile
    return h
  }

  async invoke(
    provider: string,
    action: string,
    input: Record<string, unknown>,
    extra?: Record<string, string>,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    let operation: TencentOperation | undefined
    let tracker: TencentOperations | undefined
    const cfg = this.cfgOf?.()
    const account = this.accountFor?.(provider)
    if (provider === 'tencent' && action === 'play' && input.protocol === 'mobile42') input = bindMobile42PlayInput(input)
    if (provider === 'tencent' && input.protocol !== 'mobile42' && action !== 'report' && this.tencentReportsEnabled() && (input.session_type === 'tv' || cfg?.tencentMode === 'tv')) {
      tracker = this.operationTracker()
      try { operation = await tracker.begin(action, input) } catch (error) {
        const risk = tencentRisk(undefined, error)
        writeTencentDiagnostic(this.host + String.fromCharCode(0) + this.key, { flow: '', operation: randomUUID(), job: this.diagnosticJobID, action, phase: 'binding', status: risk.status, decision: risk.decision })
        throw error
      }
      input = tracker.boundInput(operation, input)
    }
    const timeoutMs =
      opts?.timeoutMs ??
      (provider === 'tencent' && action === 'play' ? TENCENT_PLAY_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)
    if (account && account !== GW_DEFAULT_ACCOUNT) {
      // 账号的凭证已经托管在网关该账号下；别再用全局配置里的 Cookie 头覆盖它
      const { 'Iq-Cookie': _iq, 'Tx-Cookie': _tx, 'Dy-Cookie': _dy, 'Yk-Sign': _yk, ...rest } = extra ?? {}
      extra = { ...rest, [GW_ACCOUNT_HEADER]: account }
    }
    if (provider === 'douyin' && !extra?.['Dy-Cookie'] && !(account && account !== GW_DEFAULT_ACCOUNT)) {
      const ck = this.cfgOf?.()?.douyinCookie
      if (ck) extra = { ...extra, 'Dy-Cookie': ck }
    }
    const diagnosticOperation = operation?.id || randomUUID()
    const diagnostic = (data?: Record<string, unknown>, error?: unknown) => {
      const risk = tencentRisk(data, error)
      if (provider === 'tencent') {
        writeTencentDiagnostic(this.host + String.fromCharCode(0) + this.key, { flow: operation?.root.flow || '', operation: diagnosticOperation, job: this.diagnosticJobID, action, phase: error ? 'error' : 'decision', status: risk.status, decision: risk.decision, httpStatus: risk.httpStatus, code: risk.code })
        const code = risk.code && /^[0-9.]{1,16}$/.test(risk.code) ? risk.code : '-'
        runLog(`tencent_decision action=${action} source=${this.source} observations=${this.tencentReportsEnabled() ? 'on' : 'off'} job=${this.diagnosticJobID || '-'} status=${risk.status} decision=${risk.decision} code=${code} http=${risk.httpStatus || '-'}`)
      }
      return risk
    }
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
        opts?.signal,
      )
      const data = (env.data ?? {}) as Record<string, unknown>
      await tracker?.finish(operation, data)
      const risk = diagnostic(data)
      if (provider === 'tencent' && risk.stop) throw new TencentRiskStop(risk)
      runLog(
        `invoke ${provider}/${action} ${summarizeInput(input.protocol === 'mobile42' ? { ...input, mobile: '[private]' } : input)}${headerNote ? ` hdr=${headerNote}` : ''} ${Date.now() - t0}ms ok ${summarizeResult({ ...data, code: env.code, msg: env.msg })}`,
      )
      return data
    } catch (e) {
      diagnostic(undefined, e)
      if (!(e instanceof TencentRiskStop)) await tracker?.finish(operation, undefined, e).catch(() => {})
      const msg = e instanceof Error ? e.message : String(e)
      const fields = e && typeof e === 'object' ? e as Record<string, unknown> : {}
      const http = typeof fields.httpStatus === 'number' && fields.httpStatus >= 100 && fields.httpStatus <= 599 ? fields.httpStatus : '-'
      const code = typeof fields.code === 'number' && Number.isFinite(fields.code) ? fields.code : '-'
      const errorCode = typeof fields.errorCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(fields.errorCode) ? fields.errorCode : '-'
      const requestId = typeof fields.requestId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(fields.requestId) ? fields.requestId : '-'
      const details = safeGatewayDiagnostics(fields.diagnostics)
      const stage = details?.stage ?? '-'
      const upstreamHttp = details?.upstream_http ?? '-'
      runLog(
        `invoke ${provider}/${action} ${summarizeInput(input.protocol === 'mobile42' ? { ...input, mobile: '[private]' } : input)}${headerNote ? ` hdr=${headerNote}` : ''} ${Date.now() - t0}ms fail http=${http} code=${code} error_code=${errorCode} request_id=${requestId} stage=${stage} upstream_http=${upstreamHttp} ${truncate(msg, 160)}`,
      )
      throw e
    }
  }

  /** 本 Key 上传的设备文件状态；不含文件内容 */
  async drmStatus(): Promise<DRMStatus> {
    const env = await this.request('GET', '/v1/drm/devices', undefined, undefined, 15_000)
    return env.data as DRMStatus
  }

  /** 平台账号说明（只读，按 Key 权限过滤）；旧网关没有该接口时返回 null */
  async platformMeta(): Promise<PlatformMetaResponse | null> {
    try {
      const env = await this.request('GET', '/v1/meta/platforms', undefined, undefined, 15_000)
      return (env.data ?? null) as PlatformMetaResponse | null
    } catch (e) {
      if (/\b404\b|not\s*found|NOT_FOUND/i.test(e instanceof Error ? e.message : String(e))) return null
      throw e
    }
  }

  /** 上传或替换本 Key 的设备文件；网关校验格式并加密保存 */
  async putDRM(system: DRMSystem, bytes: Uint8Array, name: string): Promise<DRMFileStatus> {
    const env = await this.request('PUT', `/v1/drm/devices/${system}`, bytes, { 'X-DRM-Name': encodeURIComponent(name.slice(0, 128)) }, 60_000)
    return env.data as DRMFileStatus
  }

  async deleteDRM(system: DRMSystem): Promise<DRMStatus> {
    const env = await this.request('DELETE', `/v1/drm/devices/${system}`, undefined, undefined, 15_000)
    return env.data as DRMStatus
  }

  /** 删除设备池中的一只，其它设备保留 */
  async deleteDRMOne(system: DRMSystem, id: string): Promise<DRMStatus> {
    if (!/^(legacy|[0-9a-f]{16})$/.test(id)) throw new Error('DRM_ENTRY_INVALID')
    const env = await this.request('DELETE', `/v1/drm/devices/${system}/${encodeURIComponent(id)}`, undefined, undefined, 15_000)
    return env.data as DRMStatus
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
    signal?: AbortSignal,
  ): Promise<Envelope> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.key}` }
    let payload: string | Uint8Array<ArrayBuffer> | undefined
    if (body instanceof Uint8Array) {
      headers['Content-Type'] = 'application/octet-stream'
      payload = body as Uint8Array<ArrayBuffer>
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    if (extra) Object.assign(headers, extra)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    const cancel = () => ac.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    let res: Response
    try {
      res = await fetchGateway(`${this.host}${path}`, { method, headers, body: payload, signal: ac.signal }, this.proxyOf() ?? '')
    } catch (error) {
      if (ac.signal.aborted) throw Object.assign(new Error('请求等待超时，请检查网络后重试。'), { errorCode: 'TIMEOUT' })
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
    const text = await res.text()
    let env: Envelope
    try {
      env = JSON.parse(text) as Envelope
      if (!env || typeof env !== 'object' || typeof env.code !== 'number') throw new Error('invalid envelope')
    } catch {
      throw new Error(`http ${res.status}: ${truncate(text, 180)}`)
    }
    if (!res.ok || env.code !== 0) {
      const message = limitError(typeof env.msg === 'string' ? env.msg : '') || `http ${res.status}`
      const error = env.error_code === 'RELOGIN_REQUIRED' || RELOGIN_RE.test(message) ? new ReloginRequired(message) : new Error(message)
      const rawRequestId = env.request_id ?? res.headers.get('X-Request-ID')
      const requestId = typeof rawRequestId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(rawRequestId) ? rawRequestId : undefined
      throw Object.assign(error, { httpStatus: res.status, code: env.code, errorCode: env.error_code || '', requestId,
        diagnostics: safeGatewayDiagnostics(env.diagnostics),
        retryAfterMs: retryAfterMillis(res.headers.get('Retry-After')), userMessage: userMessage({ message, error_code: env.error_code }) })
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

/** Retain only server-provided failure coordinates; never log arbitrary data. */
function safeGatewayDiagnostics(value: unknown): { stage: string; upstream_http?: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const row = value as Record<string, unknown>
  if (typeof row.stage !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(row.stage)) return
  const upstream = typeof row.upstream_http === 'number' && Number.isInteger(row.upstream_http)
    && row.upstream_http >= 100 && row.upstream_http <= 599 ? row.upstream_http : undefined
  return { stage: row.stage, ...(upstream ? { upstream_http: upstream } : {}) }
}
