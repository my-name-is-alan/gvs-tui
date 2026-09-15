// 对比 youku play 返回里几条质量清单，看看客户端能拿到多少档。
//   PROBE_HOST=http://127.0.0.1:8080 bun run scripts/dump-youku.ts [vid]
import { GwClient } from '../src/lib/client.ts'
import { loadConfig } from '../src/lib/config.ts'
import { asString, isObj } from '../src/lib/util.ts'

const cfg = loadConfig()
const cli = new GwClient(process.env.PROBE_HOST ?? cfg.host, cfg.key)
const vid = process.argv[2] ?? 'XNjM4NTY0ODMwOA=='

for (const expand of ['0', '1']) {
  const extra = process.env.PROBE_SIGN === '1' ? cli.extra(cfg, 'youku') : undefined
  const data = await cli.invoke('youku', 'play', { vid, expand, tier: 'multi' }, extra)
  console.log(`\n================ expand=${expand} ================`)
  const arr = (k: string) => (Array.isArray(data[k]) ? (data[k] as unknown[]) : [])
  const show = (name: string, list: unknown[], pick: (o: Record<string, unknown>) => string) => {
    console.log(`-- ${name} (${list.length}) --`)
    for (const it of list) {
      if (!isObj(it)) continue
      console.log(`   ${pick(it)}`)
    }
  }
  show('streams', arr('streams'), (o) => {
    const meta = isObj(o.meta) ? o.meta : {}
    return [
      `stream_type=${asString(o.stream_type)}`,
      `media=${asString(o.media_type)}`,
      `${asString(o.width)}x${asString(o.height)}`,
      `codec=${asString(o.codecs) || asString(o.codec)}`,
      `size=${asString(o.size) || asString(meta.size)}`,
      `drm=${asString(o.drm)}`,
      `m3u8=${asString(o.has_m3u8)}`,
    ].join(' ')
  })
  show('media', arr('media'), (o) => {
    const meta = isObj(o.meta) ? o.meta : {}
    return [
      `quality=${asString(o.quality)}`,
      `type=${asString(o.type)}`,
      `${asString(o.width)}x${asString(o.height)}`,
      `codec=${asString(o.codec)}`,
      `size=${asString(o.size)}`,
      `drm=${asString(o.drm)}`,
      `meta_stream=${asString(meta.stream_type)}`,
      `meta_size=${asString(meta.size)}`,
    ].join(' ')
  })
  show('video_types', arr('video_types'), (o) => `${asString(o.name)} (${asString(o.code)}) → ${asString(o.stream_type)}`)
  const audios = arr('audios')
  const aTypes = isObj(data.audio_types) ? data.audio_types : {}
  console.log(`-- audio_types --`)
  for (const [group, list] of Object.entries(aTypes)) {
    if (!Array.isArray(list)) continue
    for (const at of list) {
      if (!isObj(at)) continue
      console.log(`   [${group}] ${asString(at.display_name)} st=${asString(at.audio_stream_type)}`)
    }
  }
  console.log(`audios=${audios.length} audio_tracks=${arr('audio_tracks').length}`)
}
process.exit(0)
