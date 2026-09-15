// 逐档验证：画质列表里的每一档，是否都能取到真实分片？
//   PROBE_HOST=http://127.0.0.1:8080 bun run scripts/check-streams.ts [vid]
import { GwClient } from '../src/lib/client.ts'
import { loadConfig } from '../src/lib/config.ts'
import { probeOptions } from '../src/lib/quality.ts'
import { youkuStreamURLs } from '../src/lib/media.ts'
import { asString, isObj } from '../src/lib/util.ts'

const cfg = loadConfig()
const cli = new GwClient(process.env.PROBE_HOST ?? cfg.host, cfg.key)
const vid = process.argv[2] ?? 'XNjM4NTY0ODMwOA=='
// 本地网关不认线上签发的 Yk-Sign；默认用空签名副本，绝不改用户配置。
const cfgLocal = { ...cfg, youkuSign: process.env.PROBE_SIGN === '1' ? cfg.youkuSign : '' }
const extra = process.env.PROBE_SIGN === '1' ? cli.extra(cfg, 'youku') : undefined

const opts = await probeOptions(cli, cfgLocal, 'youku', vid)
console.log(`画质列表 ${opts.qualities.length} 档：`)
for (const q of opts.qualities) {
  console.log(`  ${q.label.padEnd(10)} ${String(q.width).padStart(4)}x${String(q.height).padEnd(4)} ${q.codec.padEnd(5)} ${(q.size / 1048576).toFixed(0).padStart(6)} MB  id=${q.id}`)
}

const data = await cli.invoke('youku', 'play', { vid, expand: '1', tier: 'multi' }, extra)
const streams = Array.isArray(data.streams) ? data.streams : []
console.log(`\nplay 返回 streams=${streams.length}`)
for (const s of streams) {
  if (!isObj(s)) continue
  const pl = asString(s.playlist_url)
  console.log(`  ${asString(s.stream_type).padEnd(32)} media=${asString(s.media_type).padEnd(8)} playlist=${pl ? pl.slice(0, 60) + '…' : '(空)'}`)
}
const video = isObj(data.video) ? data.video : null
console.log(`\ndata.video（网关默认流）: playlist=${video ? (asString(video.playlist_url) || '(空)').slice(0, 70) : '无'}`)

console.log('\n逐档取分片（空数组=取不到）:')
let bad = 0
for (const q of opts.qualities) {
  const urls = await youkuStreamURLs(data, q.id)
  const first = urls[0] ?? ''
  const isDefault = video && first && first === asString(video.playlist_url)
  if (!urls.length) bad++
  console.log(`  ${q.label.padEnd(10)} → ${urls.length} 段  ${first.slice(0, 56)}${isDefault ? '  ← 退回默认流' : ''}`)
}
console.log(bad ? `\n✗ ${bad} 档取不到分片` : '\n✓ 每档都能取到分片')
process.exit(0)
