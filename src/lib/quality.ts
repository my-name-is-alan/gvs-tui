import type { Audio, Quality } from '../types.ts'
import type { FileConfig } from './config.ts'
import type { GwClient } from './client.ts'
import { anyInt, asBool, asString, isObj } from './util.ts'
import { hongguoItem } from './media.ts'

export type StreamOptions = { qualities: Quality[]; audios: Audio[] }

/** Everything the picker needs: one entry per quality, one per audio track. */
export async function probeOptions(
  cli: GwClient,
  cfg: FileConfig,
  provider: string,
  vid: string,
): Promise<StreamOptions> {
  switch (provider) {
    case 'hongguo': return { qualities: await probeHongguo(cli, vid), audios: [] }
    case 'youku': return probeYouku(cli, cfg, vid)
    case 'tencent': return { qualities: tencentQualityList(), audios: [] }
    case 'douyin': return { qualities: await probeDouyin(cli, vid), audios: [] }
    default: throw new Error('这个平台还没接画质列表')
  }
}

function tencentQualityList(): Quality[] {
  // 腾讯的 play 只回单条直链，档位靠 defn 参数选，所以这里是静态清单。
  return [
    { id: 'fhd', label: '蓝光', title: '蓝光', size: 0, width: 1920, height: 1080, codec: 'H265', drm: '' },
    { id: 'shd', label: '超清', title: '超清', size: 0, width: 1280, height: 720, codec: 'H265', drm: '' },
    { id: 'hd', label: '高清', title: '高清', size: 0, width: 848, height: 480, codec: 'H264', drm: '' },
    { id: 'sd', label: '标清', title: '标清', size: 0, width: 640, height: 360, codec: 'H264', drm: '' },
  ]
}

async function probeHongguo(cli: GwClient, vid: string): Promise<Quality[]> {
  const data = await cli.invoke('hongguo', 'resolve', { vid, platform: 'ios' })
  const item = hongguoItem(data, vid)
  const why = asString(item.err)
  if (why) throw new Error(why)
  const out: Quality[] = []
  const streams = Array.isArray(item.streams) ? item.streams : []
  for (const s of streams) {
    if (!isObj(s)) continue
    const qid = asString(s.quality)
    const u = asString(s.url)
    if (!qid || !u) continue
    const h = Number.parseInt(qid.toLowerCase().replace(/p$/, ''), 10) || 0
    out.push({
      id: qid,
      label: qid.toUpperCase(),
      title: qid.toUpperCase(),
      size: anyInt(s.size),
      width: 0,
      height: h,
      codec: asString(s.codec) || 'H265',
      drm: 'CENC',
    })
  }
  if (!out.length) throw new Error('红果没有可用画质')
  out.sort((a, b) => b.height - a.height)
  return out
}

async function probeDouyin(cli: GwClient, vid: string): Promise<Quality[]> {
  const data = await cli.invoke('douyin', 'resolve', { url: `https://www.douyin.com/video/${vid}` })
  const media = Array.isArray(data.media) ? data.media : []
  const out: Quality[] = []
  for (const [i, it] of media.entries()) {
    if (!isObj(it)) continue
    const u = asString(it.url)
    if (!u) continue
    const typ = asString(it.type) || 'video'
    if (typ !== 'video') continue
    const h = anyInt(it.height)
    out.push({
      id: i > 0 ? `${typ}-${i}` : typ,
      label: h > 0 ? `${h}P` : typ.toUpperCase(),
      title: asString(data.content),
      size: anyInt(it.size),
      width: anyInt(it.width),
      height: h,
      codec: asString(it.codec) || 'H264',
      drm: '',
    })
  }
  if (!out.length) throw new Error('抖音没有媒体')
  return out
}

/**
 * 优酷 `play` 一次给全：`media[]` 是每档画质的直链（带真实体积），
 * `video_types[]` 把 stream_type 映射成人话（杜比/HDR10/SDR），
 * `audio_types[].default[]` 是可配音轨，`audio_tracks[]` 是已解析好的分片。
 */
async function probeYouku(cli: GwClient, cfg: FileConfig, vid: string): Promise<StreamOptions> {
  const data = await cli.invoke('youku', 'play', { vid, tier: 'multi', expand: '0' }, cli.extra(cfg, 'youku'))

  const names = new Map<string, string>()
  if (Array.isArray(data.video_types)) {
    for (const vt of data.video_types) {
      if (!isObj(vt)) continue
      const st = asString(vt.stream_type)
      const name = asString(vt.name)
      if (st && name) names.set(st, name)
    }
  }

  const seen = new Set<string>()
  const qualities: Quality[] = []
  const media = Array.isArray(data.media) ? data.media : []
  for (const m of media) {
    if (!isObj(m)) continue
    if (asString(m.type) && asString(m.type) !== 'video') continue
    const st = asString(m.quality) || asString(m.stream_type)
    if (!st || seen.has(st)) continue
    seen.add(st)
    const h = anyInt(m.height) || anyInt(isObj(m.meta) ? m.meta.height : 0)
    const w = anyInt(m.width) || anyInt(isObj(m.meta) ? m.meta.width : 0)
    const codec = asString(m.codec) || asString(isObj(m.meta) ? m.meta.codecs : '')
    const drm = asString(m.drm) || asString(isObj(m.meta) ? m.meta.drm : '')
    qualities.push({
      id: st,
      label: names.get(st) ?? (h > 0 ? `${h}P` : st),
      title: st,
      size: anyInt(m.size) || anyInt(isObj(m.meta) ? m.meta.size : 0),
      width: w,
      height: h,
      codec: codec.split('.')[0]?.toUpperCase() || '—',
      drm,
    })
  }

  // Fallback for single-tier responses that only expose `streams[]`.
  if (!qualities.length) {
    const arr = Array.isArray(data.streams) ? data.streams : []
    for (const s of arr) {
      if (!isObj(s)) continue
      const mt = asString(s.media_type).toLowerCase()
      if (mt === 'audio' || mt === 'subtitle') continue
      const st = asString(s.stream_type)
      if (!st || seen.has(st)) continue
      seen.add(st)
      const codec = asBool(s.h265) ? 'H265' : asString(s.codecs).split('.')[0]?.toUpperCase() || 'H264'
      const h = anyInt(s.height)
      qualities.push({
        id: st,
        label: names.get(st) ?? (h > 0 ? `${h}P` : st.toUpperCase()),
        title: st,
        size: anyInt(s.size),
        width: anyInt(s.width),
        height: h,
        codec,
        drm: asString(s.drm),
      })
    }
  }
  if (!qualities.length && isObj(data.video)) {
    const h = anyInt(data.video.height)
    const st = asString(data.video.stream_type) || 'default'
    qualities.push({ id: st, label: h > 0 ? `${h}P` : st.toUpperCase(), title: st, size: 0, width: 0, height: h, codec: '', drm: '' })
  }
  if (!qualities.length) throw new Error('优酷没有画质列表')

  const audios: Audio[] = []
  const addAudio = (id: string, label: string, lang: string, codec: string, isDefault: boolean) => {
    if (!id || audios.some((a) => a.id === id)) return
    audios.push({ id, label, lang, codec, isDefault })
  }
  const audioTypes = data.audio_types
  if (isObj(audioTypes)) {
    for (const [group, list] of Object.entries(audioTypes)) {
      if (!Array.isArray(list)) continue
      for (const at of list) {
        if (!isObj(at)) continue
        addAudio(
          asString(at.audio_stream_type),
          asString(at.display_name) || asString(at.audio_stream_type).toUpperCase(),
          asString(at.audio_lang) || group,
          asString(at.audio_stream_type),
          group === 'default',
        )
      }
    }
  }
  const tracks = Array.isArray(data.audio_tracks) ? data.audio_tracks : []
  for (const tr of tracks) {
    if (!isObj(tr)) continue
    const st = asString(tr.stream_type)
    addAudio(st, asString(tr.lang) || st.toUpperCase(), asString(tr.langcode), st, asBool(tr.default))
  }
  audios.sort((a, b) => Number(b.isDefault) - Number(a.isDefault))

  return { qualities, audios }
}
