// 会员功能探测：拿一部 VIP 剧，真的 play 一次，看响应里有没有能证明「这个账号有会员权益」的字段。
//   bun run scripts/probe-vip.ts
import { GwClient } from '../src/lib/client.ts'
import { loadConfig } from '../src/lib/config.ts'
import { asString, isObj } from '../src/lib/util.ts'

const cfg = loadConfig()
const cli = new GwClient(process.env.PROBE_HOST ?? cfg.host, cfg.key)
const extra = { 'Yk-Sign': cfg.youkuSign }
const kw = process.env.KW ?? '冬城猎凶'

console.log(`网关: ${process.env.PROBE_HOST ?? cfg.host}\n`)

const s = await cli.invoke('youku', 'search', { q: kw, pageSize: 5 })
const items = (Array.isArray(s.items) ? s.items : []) as Record<string, unknown>[]
const hit = items.find((it) => isObj(it)) ?? {}
console.log('search item keys:', Object.keys(hit).sort().join(', '))
console.log(JSON.stringify(hit).slice(0, 500))
const showId = asString(hit.showId) || asString(hit.show_id) || asString(hit.id) || asString(hit.showid)
console.log(`搜索「${kw}」→ ${items.length} 条，取 ${asString(hit.title)} (showId=${showId}, vip=${String(hit.vip)})`)
if (!showId) process.exit(0)

const d = await cli.invoke('youku', 'detail', { id: showId, showId, all: '1' })
const eps = (Array.isArray(d.episodes) ? d.episodes : []) as Record<string, unknown>[]
console.log(`detail 集数=${eps.length}，第一集: ${JSON.stringify(eps[0])?.slice(0, 220)}`)

const first = eps.find((e) => isObj(e) && (asString(e.vid) || asString(e.id))) ?? {}
const vid = asString(first.vid) || asString(first.id)
console.log(`探针 vid=${vid}\n`)
if (!vid) process.exit(0)

const p = await cli.invoke('youku', 'play', { vid, tier: 'multi', expand: '0' }, extra)
console.log('play 顶层字段:', Object.keys(p).sort().join(', '))
for (const k of ['pay', 'pay_info', 'pay_info_ext', 'controller', 'trial', 'is_vip', 'can_play', 'drm', 'user', 'member', 'pay_stage', 'quality_gate', 'download_status', 'idens', 'client_ability']) {
  if (p[k] !== undefined) console.log(`  ${k} = ${JSON.stringify(p[k])?.slice(0, 400)}`)
}
const streams = Array.isArray(p.streams) ? p.streams : []
console.log(`\nstreams=${streams.length} media=${Array.isArray(p.media) ? p.media.length : 0} audio=${Array.isArray(p.audio_tracks) ? p.audio_tracks.length : 0}`)
const d0 = isObj(p.drm) ? p.drm : {}
console.log(`drm: need_decrypt=${String(d0.need_decrypt)} actually_clear=${String(d0.actually_clear)} pattern_video=${String(d0.pattern_video)} pattern_audio=${String(d0.pattern_audio)}`)
process.exit(0)
