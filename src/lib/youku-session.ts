// 优酷登录态（网关侧按 Yk-Sign 维度的多租户凭证）。
//
// 网关 `youku/cred` 提供了完整生命周期：`info` 查状态、`refresh` 用
// stoken/ptoken 续期（不需要重新扫码）、`import` 用 cookie 换发新签名、
// `revoke` 作废。TUI 之前只在请求头里塞 Yk-Sign，从来没刷新过，
// 于是 token 一过期就表现为「重启就失效」。
import type { GwClient } from './client.ts'
import type { VipProbe, VipSource } from '../types.ts'
import { anyInt, asBool, asString, isObj } from './util.ts'

export type YkLogin = {
  ok: boolean
  uid: string
  nick: string
  vip: boolean
  refreshable: boolean
  /** 凭证创建时间（毫秒），用于避免刚扫码完立刻强制刷新。 */
  createdAt: number
  /** 上次成功刷新的时间（毫秒），0 表示未知。 */
  lastRefreshAt: number
  lastError: string
  hint: string
}

export type YkRefresh = { refreshed: boolean; needsRelogin: boolean; hint: string }

/** 会员真实状态（来自 `youku/account`，不是登录时的 yktk 快照）。 */
export type YkAccount = {
  /** 网关侧 App 会话可用（search / play 靠它）。 */
  loggedIn: boolean
  /** 只有它为真才需要重新扫码。 */
  needsScan: boolean
  /** 会员状态的可信度：api=会员接口查到了；login=只有扫码时的快照；none=不知道。 */
  vipSource: VipSource
  isVip: boolean
  vipUntil: string
  nick: string
  uid: string
  ytid: string
  mobile: string
  /** 登录方式：qr / cookie / import … */
  method: string
  riskLevel: string
  hint: string
}

/** 递归找 SESSION_EXPIRED 标记。 */
function hasSessionExpired(node: unknown): boolean {
  if (!isObj(node)) return false
  const ret = node.ret
  if (Array.isArray(ret) && ret.some((r) => typeof r === 'string' && /SESSION_EXPIRED|Session过期/i.test(r))) return true
  return Object.values(node).some((v) => hasSessionExpired(v))
}

function subApiOk(profile: unknown): boolean {
  if (!isObj(profile)) return false
  for (const v of Object.values(profile)) {
    if (!isObj(v)) continue
    if (hasSessionExpired(v)) continue
    if (!Array.isArray(v.ret)) continue
    if (v.ret.length === 0) return true
    if (v.ret.some((ret) => typeof ret === 'string' && /^(SUCCESS|SUCCESS::)|调用成功/i.test(ret))) return true
  }
  return false
}

type ProfileMembership = { isVip: boolean; vipUntil: string }

/**
 * 会员接口的几代返回字段并不统一；只在已经判定为成功的 profile.data 下找
 * 明确的会员布尔值或未来到期时间，避免把 ret/error 文本误判成权益。
 */
function profileMembership(profile: unknown, now = Date.now()): ProfileMembership {
  let isVip = false
  let latest = 0
  const seen = new Set<unknown>()

  const walk = (node: unknown): void => {
    if (node === null || node === undefined || seen.has(node)) return
    if (Array.isArray(node)) {
      seen.add(node)
      for (const item of node) walk(item)
      return
    }
    if (!isObj(node)) return
    seen.add(node)
    for (const [key, value] of Object.entries(node)) {
      const norm = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
      if (['isvip', 'vip', 'ismember', 'memberactive', 'isactive'].includes(norm) && boolish(value)) {
        isVip = true
      }
      if (['endtime', 'expiretime', 'expiresat', 'expireat', 'vipexpiretime', 'vipendtime'].includes(norm)) {
        const at = membershipTime(value)
        if (at > latest) latest = at
      }
      walk(value)
    }
  }

  if (isObj(profile)) {
    for (const row of Object.values(profile)) {
      if (!isObj(row) || hasSessionExpired(row)) continue
      const ret = Array.isArray(row.ret) ? row.ret : []
      const ok = ret.length === 0 || ret.some((v) => typeof v === 'string' && /^(SUCCESS|SUCCESS::)|调用成功/i.test(v))
      if (ok) walk(row.data)
    }
  }
  if (latest > now) isVip = true
  return { isVip, vipUntil: latest > 0 ? new Date(latest).toISOString().slice(0, 10) : '' }
}

function boolish(value: unknown): boolean {
  return asBool(value) || value === 1
}

function membershipTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value
  if (typeof value !== 'string' || !value.trim()) return 0
  const raw = value.trim()
  if (/^\d+$/.test(raw)) {
    const n = Number(raw)
    return Number.isFinite(n) ? (n < 10_000_000_000 ? n * 1000 : n) : 0
  }
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 查账号与会员状态。三个踩过的坑：
 * - `cred.info` / `yktk.vip` 只是**登录当时的快照**，不能当会员状态；
 * - 会员那几个 mtop 接口要**网页会话**（`P_sck`/cookie2），扫码拿到的是 App 会话，
 *   它们报 `FAIL_SYS_SESSION_EXPIRED` 只说明「查不到会员」，**不代表登录态过期**；
 * - 真正的登录态看 `session.logged_in` + `risk.level`，掉登录时网关自己会说
 *   （`refresh` 的 `needs_relogin`），不要靠猜 ret code。
 */
export async function ykAccount(cli: GwClient, sign: string): Promise<YkAccount> {
  try {
    const data = await cli.invoke('youku', 'account', { method: 'profile', app: 'session' }, sign ? { 'Yk-Sign': sign } : undefined)
    return parseYkAccount(data)
  } catch (e) {
    const out = emptyAccount()
    const msg = e instanceof Error ? e.message : String(e)
    out.needsScan = /invalid Yk-Sign|re-login|relogin|未登录|YOUKU_RELOGIN_REQUIRED|需要重新登录/i.test(msg)
    out.loggedIn = !out.needsScan
    out.hint = msg
    return out
  }
}

export function parseYkAccount(data: Record<string, unknown>): YkAccount {
  const out = emptyAccount()
  const summary = isObj(data.summary) ? data.summary : {}
  const session = isObj(data.session) ? data.session : {}
  const risk = isObj(data.risk) ? data.risk : {}

  out.loggedIn = asBool(summary.logged_in) || asBool(session.logged_in)
  out.nick = asString(summary.nick) || asString(session.nick)
  out.uid = asString(summary.uid) || asString(session.uid)
  out.ytid = asString(summary.ytid) || asString(session.ytid)
  out.mobile = asString(session.mobile)
  out.method = asString(session.method)
  out.riskLevel = asString(risk.level) || 'none'
  out.hint = asString(risk.hint)

  if (asBool(summary.membership_known) || subApiOk(data.profile)) {
    // 新网关直接给标准化 membership_known；旧网关回退解析原始 Profile。
    const profile = profileMembership(data.profile)
    out.vipSource = 'api'
    out.isVip = asBool(summary.is_vip) || profile.isVip
    const expire = asString(summary.expire_at)
    out.vipUntil = out.isVip ? (expire ? expire.slice(0, 10) : profile.vipUntil) : ''
  } else if (asBool(session.yktk_vip) || asBool(summary.is_vip)) {
    // 扫码时带回来的权益快照：能显示，但别当权威（到期时间看不到）。
    out.vipSource = 'login'
    out.isVip = true
    out.hint = '会员到期查看需网页 Cookie（扫码登录（网页 Cookie 接口仅作内部续期））'
  } else {
    out.hint = '会员接口需要网页 Cookie（扫码登录（网页 Cookie 接口仅作内部续期））；能不能放看画质页的取流结果'
  }

  // 有 App 凭证就不算掉登录 —— 会员接口失败与登录态无关。
  out.needsScan = !out.loggedIn
  return out
}

function emptyAccount(): YkAccount {
  return {
    loggedIn: false, needsScan: false, vipSource: 'none', isVip: false, vipUntil: '',
    nick: '', uid: '', ytid: '', mobile: '', method: '', riskLevel: 'none', hint: '',
  }
}

export function accountSummary(acc: YkAccount | null, probe?: VipProbe): string {
  if (!acc) return '检查中…'
  if (acc.needsScan) return '登录态不可用 · 需重新扫码'
  if (!acc.loggedIn) return '未登录 · 需扫码'
  const who = [acc.nick, acc.uid && `uid ${acc.uid}`].filter(Boolean).join(' · ')
  const how = acc.method ? `已登录(${acc.method})` : '已登录'
  let vip: string
  if (acc.vipSource === 'api') {
    vip = acc.isVip ? (acc.vipUntil ? `会员到期 ${acc.vipUntil}` : '会员') : '账号无会员权益'
  } else if (probe?.isVip && probe.canPlay && !probe.hasTrial) {
    // 取流成功且服务端按权益给了全量流 —— 这比会员接口更硬。
    vip = acc.vipSource === 'login' ? '会员（扫码+取流确认）' : '会员（取流确认）'
  } else if (probe && !probe.canPlay) {
    vip = '取流被拒 · 权益待查'
  } else if (acc.vipSource === 'login' && acc.isVip) {
    vip = '会员（扫码时确认）'
  } else {
    vip = '会员状态未知'
  }
  const warn = acc.riskLevel && acc.riskLevel !== 'none' ? ` · 风控 ${acc.riskLevel}` : ''
  return `${who} · ${how} · ${vip}${warn}`
}

function view(data: Record<string, unknown>): YkLogin {
  const yk = isObj(data.yktk_fields) ? data.yktk_fields : {}
  return {
    ok: asBool(data.logged_in) || asBool(data.has_stoken) || anyInt(data.yktk_len) > 0
      || asString(data.uid) !== '' || asString(data.yktk) !== '' || asBool(yk.vip),
    uid: asString(data.uid),
    nick: asString(data.nick) || asString(yk.nick) || '',
    vip: asBool(yk.vip) || asBool(data.vip),
    refreshable: asBool(data.refreshable) || asBool(data.has_ptoken),
    createdAt: normalizeMillis(data.created_at),
    lastRefreshAt: Number(data.last_refresh_at ?? 0) || 0,
    lastError: asString(data.last_refresh_error),
    hint: asString(data.hint),
  }
}

/** 当前 Yk-Sign 的登录态摘要（yktk 层面的快照，会员状态请用 ykAccount）。 */
export async function ykLoginInfo(cli: GwClient, sign: string): Promise<YkLogin> {
  try {
    const data = await cli.invoke('youku', 'cred', { method: 'info' }, sign ? { 'Yk-Sign': sign } : undefined)
    return view(data)
  } catch (e) {
    return {
      ok: false, uid: '', nick: '', vip: false, refreshable: false, createdAt: 0, lastRefreshAt: 0,
      lastError: '', hint: e instanceof Error ? e.message : String(e),
    }
  }
}

/** 自动续期：旧凭证从未刷新过，或距离上次刷新超过 20 分钟。 */
export function shouldRefreshYouku(info: YkLogin | null, now = Date.now()): boolean {
  if (!info?.ok || !info.refreshable) return false
  if (info.lastRefreshAt > 0) return now - info.lastRefreshAt > 20 * 60_000
  // QR 完成后的最初一分钟不强刷；否则 ptoken 尚未完全落库时可能误报重登。
  return info.createdAt > 0 && now - info.createdAt > 60_000
}

function normalizeMillis(value: unknown): number {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n < 10_000_000_000 ? n * 1000 : n
}

/** 续期。`needsRelogin` 为真才需要重新扫码。 */
export async function ykRefresh(cli: GwClient, sign: string): Promise<YkRefresh> {
  const data = await cli.invoke('youku', 'refresh', { method: 'refresh' }, sign ? { 'Yk-Sign': sign } : undefined)
  return {
    refreshed: asBool(data.refreshed),
    needsRelogin: asBool(data.needs_relogin),
    hint: asString(data.hint),
  }
}

export function loginSummary(info: YkLogin, now = Date.now()): string {
  if (!info.ok) return info.hint ? `需重新扫码（${info.hint}）` : '未登录 / 需扫码'
  const who = [info.nick, info.uid && `uid ${info.uid}`].filter(Boolean).join(' · ')
  const when = info.lastRefreshAt > 0 ? `上次续期 ${ago(info.lastRefreshAt, now)} · ` : ''
  const warn = info.lastError ? ` · 上次刷新失败：${info.lastError}` : ''
  return `${info.refreshable ? '可续期' : '不可续期'} · ${when}${who}${warn}`
}

function ago(at: number, now: number): string {
  const mins = Math.max(0, Math.round((now - at) / 60000))
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  return `${Math.round(mins / 60)} 小时前`
}
