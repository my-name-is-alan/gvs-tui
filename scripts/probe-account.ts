// 账号/会员探测诊断：只读，不改凭证。
//   bun run scripts/probe-account.ts
// 输出刻意精简（不回显签名），用来判断「到底是真的掉登录，还是会员接口查不到」。
import { GwClient } from '../src/lib/client.ts'
import { loadConfig } from '../src/lib/config.ts'

const cfg = loadConfig()
const host = process.env.PROBE_HOST ?? cfg.host
const cli = new GwClient(host, cfg.key)
const sign = cfg.youkuSign
const H = sign ? { 'Yk-Sign': sign } : undefined

console.log(`网关: ${host}`)
console.log(`签名: ${sign ? `${sign.slice(0, 8)}…（${sign.length} 字符）` : '(空)'}\n`)

const j = (v: unknown) => JSON.stringify(v ?? null)

console.log('--- cred.info（本地凭证快照，非权威）---')
try {
  const d = await cli.invoke('youku', 'cred', { method: 'info' }, H)
  console.log(`ok=${j(d.ok)} uid=${j(d.uid)} refreshable=${j(d.refreshable)} has_ptoken=${j(d.has_ptoken)}`)
  console.log(`last_refresh_at=${j(d.last_refresh_at)} last_refresh_error=${j(d.last_refresh_error)}`)
} catch (e) {
  console.log(`失败: ${e instanceof Error ? e.message : e}`)
}

console.log('\n--- account（只看会话，不查会员接口）---')
try {
  const d = await cli.invoke('youku', 'account', { method: 'session', app: 'session' }, H)
  const s = (d.session ?? {}) as Record<string, unknown>
  console.log(`logged_in=${j(s.logged_in)} method=${j(s.method)} nick=${j(s.nick)} uid=${j(s.uid)} ytid=${j(s.ytid)}`)
  console.log(`stoken_len=${j(s.stoken_len)} yktk_len=${j(s.yktk_len)} yktk_vip=${j(s.yktk_vip)} has_ptoken=${j(s.has_ptoken)}`)
  console.log(`cookie_expires_at=${j(s.cookie_expires_at)} ptoken_expires_at=${j(s.ptoken_expires_at)}`)
  console.log(`risk=${j((d.risk as Record<string, unknown>)?.level)} hint=${j((d.risk as Record<string, unknown>)?.hint)}`)
} catch (e) {
  console.log(`失败: ${e instanceof Error ? e.message : e}`)
}

console.log('\n--- account/profile（会员接口，需网页 Cookie 才可能成功）---')
try {
  const d = await cli.invoke('youku', 'account', { method: 'profile', app: 'session' }, H)
  const sum = (d.summary ?? {}) as Record<string, unknown>
  console.log(`summary: is_vip=${j(sum.is_vip)} sources=${j(sum.sources)} logged_in=${j(sum.logged_in)} expire_at=${j(sum.expire_at)}`)
  const prof = (d.profile ?? {}) as Record<string, Record<string, unknown>>
  for (const [k, v] of Object.entries(prof)) {
    const ret = v?.ret
    const err = v?.error
    const tag = err ? 'ERR' : Array.isArray(ret) && ret.length === 0 ? 'OK ' : 'RET'
    console.log(`  ${tag} ${k.padEnd(22)} ${err ? String(err).slice(0, 70) : j(ret)}`)
  }
  if (d.profile_error) console.log(`  profile_error: ${j(d.profile_error)}`)
} catch (e) {
  console.log(`失败: ${e instanceof Error ? e.message : e}`)
}
process.exit(0)
