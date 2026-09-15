// 不带 Yk-Sign 打一次 play：看网关自己的全局会话是不是活的。
//   bun run scripts/probe-nosign.ts
import { GwClient } from '../src/lib/client.ts'
import { loadConfig } from '../src/lib/config.ts'
import { youkuVipProbe } from '../src/lib/quality.ts'
import { asString } from '../src/lib/util.ts'

const cfg = loadConfig()
const cli = new GwClient(process.env.PROBE_HOST ?? cfg.host, cfg.key)

const vid = process.env.VID ?? 'XNjU0OTU0MDc4OA=='
try {
  const p = await cli.invoke('youku', 'play', { vid, tier: 'multi', expand: '0' })
  const probe = youkuVipProbe(p)
  console.log(`无签名 play 成功：可播=${probe.canPlay} 会员=${probe.isVip} 试看=${probe.hasTrial}`)
  console.log(`quality_gate: ${JSON.stringify(p.quality_gate)?.slice(0, 200)}`)
} catch (e) {
  console.log(`无签名 play 失败：${e instanceof Error ? e.message : e}`)
}
console.log(`\n（本机配置里的签名: ${asString(cfg.youkuSign).slice(0, 8)}…）`)
process.exit(0)
