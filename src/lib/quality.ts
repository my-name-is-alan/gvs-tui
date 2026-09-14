import type { Quality } from '../types.ts'
import type { FileConfig } from './config.ts'
import type { GwClient } from './client.ts'
import { anyInt, asBool, asString, human, isObj } from './util.ts'
import { hongguoItem } from './media.ts'

export async function probeQualities(
  cli: GwClient,
  cfg: FileConfig,
  provider: string,
  vid: string,
): Promise<Quality[]> {
  switch (provider) {
    case 'hongguo': return probeHongguo(cli, vid)
    case 'youku': return probeYouku(cli, cfg, vid)
    case 'tencent':
      return [
        { id: 'fhd', label: '蓝光 fhd', title: '蓝光', size: 0, width: 1920, height: 1080, codec: 'H265', drm: '' },
        { id: 'shd', label: '超清 shd', title: '超清', size: 0, width: 1280, height: 720, codec: 'H265', drm: '' },
        { id: 'hd', label: '高清 hd', title: '高清', size: 0, width: 848, height: 480, codec: 'H264', drm: '' },
        { id: 'sd', label: '标清 sd', title: '标清', size: 0, width: 640, height: 360, codec: 'H264', drm: '' },
      ]
    case 'douyin': return probeDouyin(cli, vid)
    default: throw new Error('这个平台还没接画质列表')
  }
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
    out.push({ id: qid, label: qid.toUpperCase(), title: qid.toUpperCase(), size: 0, width: 0, height: h, codec: 'H265', drm: 'CENC' })
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
    const h = anyInt(it.height)
    out.push({
      id: i > 0 ? `${typ}-${i}` : typ,
      label: h > 0 ? `${typ} ${h}p` : typ,
      title: asString(data.content),
      size: 0,
      width: anyInt(it.width),
      height: h,
      codec: 'H264',
      drm: '',
    })
  }
  if (!out.length) throw new Error('抖音没有媒体')
  return out
}

async function probeYouku(cli: GwClient, cfg: FileConfig, vid: string): Promise<Quality[]> {
  const data = await cli.invoke('youku', 'play', { vid, tier: 'multi', expand: '0' }, cli.extra(cfg, 'youku'))
  const arr = Array.isArray(data.streams) ? data.streams : []
  const seen: Record<string, true> = {}
  const out: Quality[] = []
  for (const s of arr) {
    if (!isObj(s)) continue
    const mt = asString(s.media_type).toLowerCase()
    if (mt === 'audio' || mt === 'subtitle') continue
    const qid = asString(s.stream_type)
    if (!qid || seen[qid]) continue
    seen[qid] = true
    const h = anyInt(s.height)
    const w = anyInt(s.width)
    const sz = anyInt(s.size)
    const codec = asBool(s.h265) ? 'H265' : 'H264'
    let res = qid
    if (h > 0 && w > 0) res = `${w}x${h}`
    else if (h > 0) res = `${h}p`
    let label = res
    if (sz > 0) label += `  ${human(sz)}`
    label += `  ${codec}`
    out.push({ id: qid, label, title: qid, size: sz, width: w, height: h, codec, drm: asString(s.drm) })
  }
  if (!out.length && isObj(data.video)) {
    const h = anyInt(data.video.height)
    const qid = asString(data.video.stream_type) || 'default'
    out.push({ id: qid, label: h > 0 ? `${h}p  ${qid}` : qid, title: qid, size: 0, width: 0, height: h, codec: '', drm: '' })
  }
  if (!out.length) throw new Error('优酷没有画质列表')
  out.sort((a, b) => b.height - a.height)
  return out
}
