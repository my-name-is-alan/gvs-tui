import type { Audio, Quality, VipProbe } from '../types.ts'
import type { FileConfig } from './config.ts'
import type { GwClient } from './client.ts'
import { anyInt, asBool, asString, isObj } from './util.ts'
import { hongguoItem } from './media.ts'

export type StreamOptions = { qualities: Quality[]; audios: Audio[]; vip?: VipProbe }

/** Everything the picker needs: one entry per quality, one per audio track. */
export async function probeOptions(
  cli: GwClient,
  cfg: FileConfig,
  provider: string,
  vid: string,
  opts: { skipSign?: boolean } = {},
): Promise<StreamOptions> {
  switch (provider) {
    case 'hongguo': return { qualities: await probeHongguo(cli, vid), audios: [] }
    case 'youku': return probeYouku(cli, cfg, vid, opts)
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
async function probeYouku(
  cli: GwClient,
  cfg: FileConfig,
  vid: string,
  opts: { skipSign?: boolean } = {},
): Promise<StreamOptions> {
  const data = await cli.invoke('youku', 'play', { vid, tier: 'multi', expand: '0' }, cli.extra(cfg, 'youku', opts.skipSign))

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
  /** 优酷 stream_type → 人话。4K 档用 video_types 给的名字（杜比/HDR10/SDR），
   *  普通码按命名规则推断，因为 letterbox 过的真实高度（1608/808…）不能当档位名。 */
  const label = (st: string, height: number): string => {
    const named = names.get(st)
    if (named) return named
    const t = st.toLowerCase()
    if (t.startsWith('hls5hd4') || t.includes('hd4')) return '4K'
    if (t.includes('hd3')) return '1080P'
    if (t.includes('hd2')) return '720P'
    if (t === 'mp4hd' || t === 'mp5hd') return '480P'
    if (t === 'flvhd' || t === 'mp5sd') return '360P'
    return height > 0 ? `${height}P` : st.toUpperCase()
  }
  const add = (
    st: string,
    width: number,
    height: number,
    size: number,
    codecRaw: string,
    drm: string,
  ): void => {
    if (!st || seen.has(st)) return
    seen.add(st)
    const codec = (codecRaw.split('.')[0] ?? '').toUpperCase()
    qualities.push({
      id: st,
      label: label(st, height),
      title: st,
      size,
      width,
      height,
      codec: codec || '—',
      drm,
    })
  }

  const media = Array.isArray(data.media) ? data.media : []
  const streams = Array.isArray(data.streams) ? data.streams : []
  // media[] 只带体积/编码这类元数据，能不能下取决于它有没有分片清单，
  // 所以以 streams[] 为准（早先只按 media 列，列表里可能出现根本取不到流的档位）。
  const mediaByStream = new Map<string, Record<string, unknown>>()
  for (const m of media) {
    if (!isObj(m)) continue
    mediaByStream.set(asString(m.quality) || asString(m.stream_type), m)
  }

  for (const s of streams) {
    if (!isObj(s)) continue
    const kind = asString(s.media_type).toLowerCase()
    if (kind === 'audio' || kind === 'subtitle') continue
    const st = asString(s.stream_type)
    if (!st || seen.has(st)) continue
    if (!asString(s.playlist_url) && !asString(s.url)) continue // 没有真实分片 → 不列出来
    const m = mediaByStream.get(st) ?? {}
    const meta = isObj(m.meta) ? m.meta : {}
    add(
      st,
      anyInt(s.width) || anyInt(m.width) || anyInt(meta.width),
      anyInt(s.height) || anyInt(m.height) || anyInt(meta.height),
      anyInt(s.size) || anyInt(m.size) || anyInt(meta.size),
      asString(s.codecs) || asString(m.codec) || asString(meta.codecs) || (asBool(s.h265) ? 'H265' : ''),
      asString(s.drm) || asString(m.drm) || asString(meta.drm),
    )
  }

  // 兜底：有的片源只给 media[]，那就按 media 列（仍然要求有 url）。
  if (!qualities.length) {
    for (const m of media) {
      if (!isObj(m)) continue
      const kind = asString(m.type).toLowerCase()
      if (kind === 'audio' || kind === 'subtitle') continue
      const meta = isObj(m.meta) ? m.meta : {}
      if (!asString(m.url) && !asString(meta.playlist_url)) continue
      add(
        asString(m.quality) || asString(m.stream_type),
        anyInt(m.width) || anyInt(meta.width),
        anyInt(m.height) || anyInt(meta.height),
        anyInt(m.size) || anyInt(meta.size),
        asString(m.codec) || asString(meta.codecs),
        asString(m.drm) || asString(meta.drm),
      )
    }
  }
  if (!qualities.length && isObj(data.video)) {
    const h = anyInt(data.video.height)
    const st = asString(data.video.stream_type) || 'default'
    qualities.push({ id: st, label: h > 0 ? `${h}P` : st.toUpperCase(), title: st, size: 0, width: 0, height: h, codec: '', drm: '' })
  }
  if (!qualities.length) throw new Error('优酷没有画质列表')
  // 高分辨率在前；同分辨率保持接口给的顺序（4K 杜比/HDR 在前，普通码在后）。
  qualities.sort((a, b) => b.width * b.height - a.width * a.height || b.size - a.size)

  const audios: Audio[] = []
  const addAudio = (id: string, label: string, lang: string, codec: string, isDefault: boolean) => {
    if (!id || audios.some((a) => a.id === id)) return
    audios.push({ id, label, lang, codec, isDefault, selected: isDefault })
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

  return { qualities, audios, vip: youkuVipProbe(data) }
}

/**
 * 从 `play` 的响应里读「这个账号现在到底能不能放」。
 *
 * 这是唯一可信的会员判据：`account` 的那几个 mtop 会员接口要网页 Cookie，
 * 扫码登录后必然报 SESSION_EXPIRED（≠ 掉登录），而 `play` 是真的取到了流，
 * 服务端已经按 能力∩片源∩账号权益 裁过一次（`quality_gate` 就是这么写的）。
 */
export function youkuVipProbe(data: Record<string, unknown>): VipProbe {
  const gate = isObj(data.quality_gate) ? data.quality_gate : {}
  const canPlay = asBool(gate.can_play) || asBool(data.can_play)
  const isVip = asBool(gate.is_vip) || asBool(data.is_vip)
  const hasTrial = asBool(gate.has_trial)
  const download = asString(gate.download_status) || asString(data.download_status)
  const notes: string[] = []
  if (hasTrial) notes.push('服务端只给试看档')
  if (download.includes('svip_ahead')) notes.push('SVIP 抢先看池')
  if (asBool(gate.low_res)) notes.push('被裁到低清')
  return {
    canPlay,
    isVip,
    hasTrial,
    download,
    note: notes.join(' · '),
  }
}
