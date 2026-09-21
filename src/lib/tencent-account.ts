import type { GwClient } from './client.ts'

export type TxSide = {
  loggedIn: boolean
  nick: string
  vipSummary: string
  isVip: boolean
}

export type TxAccount = {
  loggedIn: boolean
  nick: string
  app: TxSide
  tv: TxSide
  cookie: TxSide
  summary: string
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function sideFrom(raw: unknown): TxSide {
  const o = asObj(raw) || {}
  const loggedIn = o.logged_in === true || o.loggedIn === true
  const nick = str(o.nick)
  const vipSummary = str(o.vip_summary || o.vipSummary)
  const isVip = o.is_vip === true || o.isVip === true || Boolean(vipSummary)
  return { loggedIn, nick, vipSummary, isVip }
}

function sideLine(label: string, s: TxSide): string {
  if (!s.loggedIn) return `${label}未登录`
  const bits = [`${label}已登录`]
  if (s.nick) bits.push(s.nick)
  if (s.vipSummary) bits.push(s.vipSummary)
  else if (s.isVip) bits.push('会员')
  return bits.join(' · ')
}

export function txAccountSummary(acc: TxAccount | null): string {
  if (!acc || !acc.loggedIn) return '未登录 · 双扫码或粘贴 Cookie'
  const parts: string[] = []
  if (acc.tv.loggedIn) parts.push(sideLine('TV', acc.tv))
  if (acc.app.loggedIn) parts.push(sideLine('App', acc.app))
  if (acc.cookie.loggedIn) parts.push(sideLine('Cookie', acc.cookie))
  return parts.join(' ｜ ') || acc.nick || '已登录'
}

function fromAccountPayload(data: Record<string, unknown>): TxAccount {
  const app = sideFrom(data.app)
  const tv = sideFrom(data.tv)
  const cookie = sideFrom(data.cookie)
  // legacy session shape: app_logged_in / tv_logged_in / nick
  if (!app.loggedIn && data.app_logged_in === true) app.loggedIn = true
  if (!tv.loggedIn && (data.tv_logged_in === true || data.tvLoggedIn === true))
    tv.loggedIn = true
  if (!cookie.loggedIn && data.logged_in === true && !app.loggedIn && !tv.loggedIn)
    cookie.loggedIn = true
  if (!app.nick && str(data.app_nick)) app.nick = str(data.app_nick)
  if (!tv.nick && str(data.tv_nick)) tv.nick = str(data.tv_nick)
  const loggedIn = app.loggedIn || tv.loggedIn || cookie.loggedIn
  const nick = str(data.nick) || tv.nick || app.nick || cookie.nick
  const acc: TxAccount = { loggedIn, nick, app, tv, cookie, summary: '' }
  acc.summary = txAccountSummary(acc)
  return acc
}

/** Prefer `account`; fall back to `session` + scoped `login state=session`. */
export async function fetchTencentAccount(cli: GwClient): Promise<TxAccount> {
  try {
    const data = await cli.invoke('tencent', 'account', {})
    return fromAccountPayload(data)
  } catch {
    // older gateways: no /tencent/account
  }
  let base: Record<string, unknown> = {}
  try {
    base = await cli.invoke('tencent', 'session', {})
  } catch {
    base = {}
  }
  const mergeSide = async (mode: 'app' | 'tv') => {
    try {
      const row = await cli.invoke('tencent', 'login', {
        method: mode,
        session_type: mode,
        state: 'session',
      })
      return sideFrom(row)
    } catch {
      return sideFrom(null)
    }
  }
  const [app, tv] = await Promise.all([mergeSide('app'), mergeSide('tv')])
  const cookie = sideFrom({
    logged_in: base.logged_in === true && !app.loggedIn && !tv.loggedIn,
    nick: str(base.nick),
    vuserid: base.vuserid,
  })
  if (base.app_logged_in === true) app.loggedIn = true
  if (base.tv_logged_in === true) tv.loggedIn = true
  if (str(base.app_nick)) app.nick = str(base.app_nick)
  if (str(base.tv_nick)) tv.nick = str(base.tv_nick)
  const asApp = asObj(base.app)
  const asTv = asObj(base.tv)
  if (asApp) Object.assign(app, sideFrom(asApp))
  if (asTv) Object.assign(tv, sideFrom(asTv))
  const acc: TxAccount = {
    loggedIn: app.loggedIn || tv.loggedIn || cookie.loggedIn,
    nick: str(base.nick) || tv.nick || app.nick,
    app,
    tv,
    cookie,
    summary: '',
  }
  acc.summary = txAccountSummary(acc)
  return acc
}
