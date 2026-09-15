// 验证「探测」本身：TUI 会怎么说（不跑 TUI）。
//   bun run scripts/check-detect.ts
import { GwClient } from '../src/lib/client.ts'
import { loadConfig } from '../src/lib/config.ts'
import { youkuVipProbe } from '../src/lib/quality.ts'
import { accountSummary, ykAccount } from '../src/lib/youku-session.ts'
import { asString, isObj } from '../src/lib/util.ts'

const cfg = loadConfig()
const cli = new GwClient(process.env.PROBE_HOST ?? cfg.host, cfg.key)
const sign = cfg.youkuSign

console.log('--- 账号行（首页第一行）---')
const acc = await ykAccount(cli, sign)
console.log(accountSummary(acc))
console.log(`needsScan=${acc.needsScan}  vipSource=${acc.vipSource}  risk=${acc.riskLevel}`)
if (acc.hint) console.log(`hint: ${acc.hint}`)

console.log('\n--- 画质页权益徽标（真实取流）---')
const kw = process.env.KW ?? '冬城猎凶'
const s = await cli.invoke('youku', 'search', { q: kw, pageSize: 5 })
const items = (Array.isArray(s.items) ? s.items : []) as Record<string, unknown>[]
const showId = asString((items[0] ?? {}).id)
const d = await cli.invoke('youku', 'detail', { id: showId, showId, all: '1' })
const eps = (Array.isArray(d.episodes) ? d.episodes : []) as Record<string, unknown>[]
const vid = asString((eps[0] ?? {}).vid) || asString((eps[0] ?? {}).id)
const p = await cli.invoke('youku', 'play', { vid, tier: 'multi', expand: '0' }, { 'Yk-Sign': sign })
const probe = youkuVipProbe(p)
const bits = [probe.canPlay ? '可播' : '不可播']
if (probe.isVip) bits.push('会员✓')
if (probe.hasTrial) bits.push('仅试看')
if (probe.note) bits.push(probe.note)
console.log(`权益: ${bits.join(' · ')}`)
console.log(`download_status=${probe.download}  streams=${Array.isArray(p.streams) ? p.streams.length : 0}  gate.max=${isObj(p.quality_gate) ? `${String(p.quality_gate.max_width)}x${String(p.quality_gate.max_height)}` : '-'}`)
process.exit(0)
