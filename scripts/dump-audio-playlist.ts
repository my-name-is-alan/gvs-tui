// 看优酷音轨 playlist 到底是什么结构（master 还是 media），以及分片 URL 的构成。
//   PROBE_HOST=http://127.0.0.1:8080 bun run scripts/dump-audio-playlist.ts [vid]
import { GwClient } from '../src/lib/client.ts'
import { loadConfig } from '../src/lib/config.ts'
import { referer } from '../src/lib/media.ts'
import { asString, isObj } from '../src/lib/util.ts'

const cfg = loadConfig()
const cli = new GwClient(process.env.PROBE_HOST ?? cfg.host, cfg.key)
const vid = process.argv[2] ?? 'XMjQ4NDcxODQwOA=='
const data = await cli.invoke('youku', 'play', { vid, expand: '1', tier: 'multi' }, process.env.PROBE_SIGN === '1' ? cli.extra(cfg, 'youku') : undefined)

const tracks = Array.isArray(data.audio_tracks) ? data.audio_tracks : []
console.log(`audio_tracks=${tracks.length}`)
for (const tr of tracks) {
  if (!isObj(tr)) continue
  console.log(`  stream=${asString(tr.stream_type)} lang=${asString(tr.lang)} default=${asString(tr.default)} playlist=${asString(tr.playlist_url).slice(0, 90)}`)
}

const first = tracks.find((t) => isObj(t) && asString(t.playlist_url))
if (!first || !isObj(first)) {
  console.log('没有 playlist_url')
  process.exit(1)
}
const url = asString(first.playlist_url)
const res = await fetch(url, { headers: { Referer: referer('youku'), 'User-Agent': 'Mozilla/5.0' } })
const text = await res.text()
const lines = text.split('\n')
console.log(`\nplaylist HTTP ${res.status}  ${lines.length} 行，前 25 行：`)
for (const line of lines.slice(0, 25)) console.log(`  ${line.trim().slice(0, 150)}`)

const isMaster = text.includes('#EXT-X-STREAM-INF')
const mapLine = lines.find((l) => l.includes('#EXT-X-MAP'))
console.log(`\nmaster=${isMaster}  EXT-X-MAP=${mapLine ? mapLine.trim().slice(0, 90) : '(无)'}`)

const uris = lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
console.log(`分片 URI 数: ${uris.length}`)
console.log(`前 3 条:\n  ${uris.slice(0, 3).join('\n  ')}`)
console.log(`末 2 条:\n  ${uris.slice(-2).join('\n  ')}`)

// 抽 3 个分片看响应：是否都是音频（ftyp/moof 结构一致）
for (const u of [uris[0], uris[Math.floor(uris.length / 2)], uris[uris.length - 2]].filter(Boolean)) {
  const abs = u.startsWith('http') ? u : new URL(u, url).toString()
  const r = await fetch(abs, { headers: { Referer: referer('youku'), 'User-Agent': 'Mozilla/5.0' } })
  const buf = Buffer.from(await r.arrayBuffer())
  const ascii = buf.subarray(0, 32).toString('binary').replace(/[^\x20-\x7e]/g, '.')
  console.log(`  ${r.status} ${buf.length}B  ${abs.slice(0, 70)}  head=${ascii}`)
}
process.exit(0)
