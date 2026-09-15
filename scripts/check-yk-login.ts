// 查本机 Yk-Sign 在网关侧的登录态，并试一次续期（不会改本地配置）。
//   bun run scripts/check-yk-login.ts         # 打配置里的网关
//   PROBE_HOST=http://127.0.0.1:8080 ...      # 打本地网关（本地没有凭证时会报需扫码）
import { GwClient } from '../src/lib/client.ts'
import { loadConfig } from '../src/lib/config.ts'
import { loginSummary, ykLoginInfo, ykRefresh } from '../src/lib/youku-session.ts'

const cfg = loadConfig()
const cli = new GwClient(process.env.PROBE_HOST ?? cfg.host, cfg.key)
const sign = cfg.youkuSign

console.log(`网关: ${process.env.PROBE_HOST ?? cfg.host}`)
console.log(`本地 Yk-Sign: ${sign ? `${sign.slice(0, 10)}…（${sign.length} 字符）` : '(空)'}`)
if (!sign) {
  console.log('本地没有签名 → 设置 → 优酷扫码')
  console.log('\n--- account/profile（会员真实状态）---')
try {
  const acc = await cli.invoke('youku', 'account', { method: 'profile' }, { 'Yk-Sign': sign })
  console.log('summary:', JSON.stringify((acc as Record<string, unknown>).summary ?? null))
  const prof = (acc as Record<string, unknown>).profile
  console.log('profile:', JSON.stringify(prof, null, 2)?.slice(0, 1500))
} catch (e) {
  console.log('account 失败:', e instanceof Error ? e.message : e)
}
process.exit(0)
}

console.log('\n--- cred info ---')
const info = await ykLoginInfo(cli, sign)
console.log(JSON.stringify(info, null, 2))
console.log(`摘要: ${loginSummary(info)}`)

console.log('\n--- refresh ---')
try {
  const res = await ykRefresh(cli, sign)
  console.log(JSON.stringify(res, null, 2))
  const after = await ykLoginInfo(cli, sign)
  console.log(`续期后: ${loginSummary(after)}`)
  if (res.needsRelogin) console.log('结论: 需要重新扫码（设置 → 优酷扫码）')
  else console.log(res.refreshed ? '结论: 已续期，可以继续用原来的签名' : '结论: 无需续期，签名有效')
} catch (e) {
  console.log(`refresh 失败: ${e instanceof Error ? e.message : e}`)
}
console.log('\n--- account/profile（会员真实状态）---')
try {
  const acc = await cli.invoke('youku', 'account', { method: 'profile' }, { 'Yk-Sign': sign })
  console.log('summary:', JSON.stringify((acc as Record<string, unknown>).summary ?? null))
  const prof = (acc as Record<string, unknown>).profile
  console.log('profile:', JSON.stringify(prof, null, 2)?.slice(0, 1500))
} catch (e) {
  console.log('account 失败:', e instanceof Error ? e.message : e)
}
process.exit(0)
