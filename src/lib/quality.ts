import type { Audio, Episode, Quality, VipProbe } from '../types.ts'
import type { FileConfig } from './config.ts'
import { ReloginRequired, type GwClient } from './client.ts'
import { anyInt, asBool, asString, isObj } from './util.ts'
import { hongguoItem, pickHongguo } from './media.ts'
import { hongguoResolveInput } from './hongguo.ts'
import { tencentPlayInput } from './tencent-qr.ts'

export type StreamOptions = { qualities: Quality[]; audios: Audio[]; vip?: VipProbe }

/** Map Youku play payload → TUI audio rows. Gateway catalog is `audios[]`. */
export function youkuAudiosFromPlay(data: Record<string, unknown>, sourceVid = '', editionLang = ''): Audio[] {
  const audios: Audio[] = []
  const lang = editionLang || youkuLangForVid(data, sourceVid)
  const addAudio = (id: string, label: string, streamLang: string, codec: string, isDefault: boolean) => {
    if (!id || audios.some((a) => a.id === id)) return
    const keyed = sourceVid ? `${sourceVid}|${id}` : id
    if (audios.some((a) => a.id === keyed)) return
    audios.push({ id: keyed, label, lang: lang || streamLang, codec, isDefault, selected: true, vid: sourceVid || undefined })
  }

  const tracks = Array.isArray(data.audio_tracks) ? data.audio_tracks : []
  for (const tr of tracks) {
    if (!isObj(tr)) continue
    const st = asString(tr.stream_type)
    addAudio(
      st,
      youkuAudioCodecLabel(st, asString(tr.lang)),
      youkuAudioLangLabel(asString(tr.lang), asString(tr.langcode)),
      st,
      asBool(tr.default),
    )
  }

  const catalog = Array.isArray(data.audios) ? data.audios : []
  for (const a of catalog) {
    if (!isObj(a)) continue
    const st = asString(a.stream_type)
    addAudio(
      st,
      youkuAudioCodecLabel(st, asString(a.name) || asString(a.title)),
      youkuAudioLangLabel(asString(a.lang), asString(a.langcode)),
      asString(a.codec) || st,
      asBool(a.default),
    )
  }

  const audioTypes = data.audio_types
  if (isObj(audioTypes)) {
    for (const [group, list] of Object.entries(audioTypes)) {
      if (!Array.isArray(list)) continue
      for (const at of list) {
        if (!isObj(at)) continue
        const st = asString(at.audio_stream_type)
        addAudio(
          st,
          youkuAudioCodecLabel(st, asString(at.display_name)),
          youkuAudioLangLabel(asString(at.audio_lang) || group, asString(at.langcode)),
          st,
          group === 'default',
        )
      }
    }
  }

  if (!audios.some((a) => a.isDefault) && audios.length) audios[0]!.isDefault = true
  sortYoukuAudios(audios)
  return audios
}

function sortYoukuAudios(audios: Audio[]): void {
  const codecRank = (a: Audio): number => {
    const s = a.id.toLowerCase()
    if (/atmos|cmfa4|dolby/.test(s)) return 0
    if (/dts|cmfa3/.test(s)) return 1
    if (/aac|cmfa1/.test(s)) return 2
    return 3
  }
  const langRank = (lang: string): number => {
    if (lang === '英语') return 0
    if (lang === '普通话') return 1
    if (lang.includes('粤')) return 2
    return 3
  }
  audios.sort((a, b) => langRank(a.lang) - langRank(b.lang) || codecRank(a) - codecRank(b) || Number(b.isDefault) - Number(a.isDefault))
}

export function youkuMergeEditionAudios(
  primaryVid: string,
  primary: Record<string, unknown>,
  extras: Array<{ vid: string; data: Record<string, unknown>; lang?: string }>,
): Audio[] {
  const audios = youkuAudiosFromPlay(primary, primaryVid, youkuLangForVid(primary, primaryVid))
  for (const extra of extras) {
    if (!extra.vid || extra.vid === primaryVid) continue
    const lang = extra.lang || youkuLangForVid(primary, extra.vid) || youkuLangForVid(extra.data, extra.vid)
    for (const a of youkuAudiosFromPlay(extra.data, extra.vid, lang)) {
      a.isDefault = false
      if (!audios.some((x) => x.id === a.id)) audios.push(a)
    }
  }
  sortYoukuAudios(audios)
  return audios
}

function youkuAudioCodecLabel(st: string, fallback: string): string {
  const t = st.toLowerCase()
  // `cmfa4` identifies the Dolby/CMFA family, but does not by itself mean
  // Atmos.  Youku uses an explicit `atmos` marker for Atmos variants such as
  // `cmfa4hd5_atmos51`; plain `cmfa4hd4_51` is only Dolby 5.1.
  if (t.includes('dtsx') || t.includes('dts-x') || t.includes('dts_x')) return 'DTS:X'
  if (t.includes('atmos')) return '杜比全景声'
  if (t.includes('cmfa4') || t.includes('dolby')) return /(?:^|[_-])51(?:$|[_-])/.test(t) ? '杜比 5.1' : '杜比'
  if (t.includes('dts') || t.includes('cmfa3')) return 'DTS'
  if (t.includes('cmfa1') || t.includes('aac')) return 'AAC'
  const fb = fallback.trim()
  if (fb && !/^(en|eng|default|guoyu)$/i.test(fb)) return fb
  return st ? st.toUpperCase() : fb
}

function youkuAudioLangLabel(lang: string, langcode: string): string {
  if (isCodecLangToken(lang)) lang = ''
  if (isCodecLangToken(langcode)) langcode = ''
  const s = `${langcode} ${lang}`.toLowerCase()
  if (/(英语|english|\ben\b|\beng\b)/.test(s) || langcode.toLowerCase() === 'en') return '英语'
  if (/(普通|国语|guoyu|\bchi\b|\bzh\b)/.test(s)) return '普通话'
  if (lang && !/^(en|eng|default)$/i.test(lang)) return lang
  return langcode || lang || '原声'
}

function isCodecLangToken(s: string): boolean {
  return /^(aac|dolby|dts|atmos|eac3|ac3|ec3|e-ac3|default)$/i.test(s.trim())
}

export function youkuEditionLabel(lang: string, langcode: string): string {
  const s = `${langcode} ${lang}`.toLowerCase()
  if (/(英语|english|\ben\b|\beng\b)/.test(s) || langcode.toLowerCase() === 'en') return '英语版'
  if (/粤/.test(s)) return '粤语版'
  if (/(普通|国语|guoyu|\bchi\b|\bzh\b)/.test(s)) return '国语版'
  const name = lang.trim() || langcode.trim()
  return name ? `${name}版` : '原声版'
}

/** dvd.audiolang → movie detail rows (国语版 / 英语版), one vid each. */
export function youkuEditionsFromDetail(data: Record<string, unknown>): Episode[] {
  const arr = Array.isArray(data.languages) ? data.languages : []
  const seen: Record<string, true> = {}
  const out: Episode[] = []
  for (const it of arr) {
    if (!isObj(it)) continue
    const vid = asString(it.vid)
    if (!vid || seen[vid]) continue
    seen[vid] = true
    out.push({
      title: youkuEditionLabel(asString(it.lang), asString(it.langcode)),
      vid,
      number: out.length + 1,
      selected: false,
      group: 'edition',
    })
  }
  return out
}

/** Movies are not episode lists. Dual-language dvds collapse to one 正片. */
export function moviePlayables(
  data: Record<string, unknown>,
  play?: Record<string, unknown>,
): Episode[] {
  const src = play ?? data
  const editions = youkuEditionsFromDetail(src)
  const languages = youkuLanguageRefs(src)
  if (editions.length > 1) {
    const arr = Array.isArray(src.languages) ? src.languages : []
    let mainVid = editions[0]!.vid
    for (const it of arr) {
      if (isObj(it) && asBool(it.main) && asString(it.vid)) {
        mainVid = asString(it.vid)
        break
      }
    }
    const duration = anyInt(data.duration)
    return [{
      title: '正片',
      vid: mainVid,
      number: 1,
      selected: false,
      duration: duration > 0 ? duration : undefined,
      group: 'edition',
      languages,
    }]
  }
  if (editions.length === 1) return editions.map((e) => ({ ...e, languages }))
  const vid = asString(data.vid)
  if (!vid) return []
  const duration = anyInt(data.duration)
  return [
    {
      title: '正片',
      vid,
      number: 1,
      selected: false,
      duration: duration > 0 ? duration : undefined,
      group: 'edition',
      languages: languages.length ? languages : undefined,
    },
  ]
}

export function youkuLanguageRefs(data: Record<string, unknown>): Array<{ vid: string; lang: string; langcode?: string }> {
  const arr = Array.isArray(data.languages) ? data.languages : []
  const seen: Record<string, true> = {}
  const out: Array<{ vid: string; lang: string; langcode?: string }> = []
  for (const it of arr) {
    if (!isObj(it)) continue
    const vid = asString(it.vid)
    const lang = youkuAudioLangLabel(asString(it.lang), asString(it.langcode))
    if (!lang) continue
    const key = vid || '*'
    if (seen[key]) continue
    seen[key] = true
    out.push({
      vid,
      lang,
      langcode: asString(it.langcode) || undefined,
    })
  }
  return out
}

export function youkuLangForVid(data: Record<string, unknown>, vid: string): string {
  const refs = youkuLanguageRefs(data)
  if (vid) {
    for (const it of refs) {
      if (it.vid === vid) return it.lang
    }
  }
  if (refs.length === 1) return refs[0]!.lang
  return ''
}




/** Everything the picker needs: one entry per quality, one per audio track. */
export async function probeOptions(
  cli: GwClient,
  cfg: FileConfig,
  provider: string,
  vid: string,
  opts: { skipSign?: boolean; languages?: Array<{ vid: string; lang: string }> } = {},
): Promise<StreamOptions> {
  switch (provider) {
    case 'hongguo': return probeHongguo(cli, vid)
    case 'youku': return probeYouku(cli, cfg, vid, opts)
    case 'tencent': return probeTencent(cli, cfg, vid)
    case 'douyin': return { qualities: await probeDouyin(cli, vid), audios: [] }
    default: throw new Error('这个平台还没接画质列表')
  }
}

/** Fallback when play returns no formats[] (old gateway / cookie path). */
function tencentQualityList(): Quality[] {
  return [
    { id: 'fhd', label: '蓝光', title: '蓝光', size: 0, width: 1920, height: 1080, codec: 'H265', drm: '', stream: 'fhd', group: 'main' },
    { id: 'shd', label: '超清', title: '超清', size: 0, width: 1280, height: 720, codec: 'H265', drm: '', stream: 'shd', group: 'main' },
    { id: 'hd', label: '高清', title: '高清', size: 0, width: 848, height: 480, codec: 'H264', drm: '', stream: 'hd', group: 'main' },
    { id: 'sd', label: '标清', title: '标清', size: 0, width: 640, height: 360, codec: 'H264', drm: '', stream: 'sd', group: 'main' },
  ]
}

const TENCENT_DEFN_RANK: Record<string, number> = {
  source: 1000,
  original: 1000,
  '8k': 900,
  suhd: 850,
  maxplus: 800,
  max: 780,
  uhd: 760,
  hdr10: 740,
  dolby: 730,
  fhd: 700,
  shd: 600,
  hd: 500,
  sd: 400,
  audio: 100,
}

function tencentDefnRank(name: string): number {
  const n = name.toLowerCase()
  if (TENCENT_DEFN_RANK[n] != null) return TENCENT_DEFN_RANK[n]!
  if (n.includes('maxplus')) return 800
  if (n.includes('max')) return 780
  if (n.includes('uhd') || n.includes('4k')) return 760
  if (n.includes('fhd') || n.includes('1080')) return 700
  if (n.includes('shd') || n.includes('720')) return 600
  if (n.includes('hd') || n.includes('480')) return 500
  if (n === 'source' || n.includes('原画')) return 1000
  return 200
}

function tencentFormatGroup(f: Record<string, unknown>): 'main' | 'encode' | 'source' {
  const name = asString(f.name).toLowerCase()
  const persona = asString(f.persona).toLowerCase()
  if (name === 'source' || name === 'original' || persona === 'source') return 'source'
  // encode=all personas: default_soft, 2741517771455_hard, h264_soft…
  if (
    persona &&
    !persona.startsWith('l3_') &&
    persona !== 'samsung_dolby' &&
    persona !== 'phone_normal' &&
    (persona.startsWith('default_') ||
      persona.startsWith('h264_') ||
      /^\d+_/.test(persona) ||
      persona.includes('encode'))
  ) {
    return 'encode'
  }
  return 'main'
}

function tencentCaptionLabel(raw: string): string {
  const c = raw.toLowerCase()
  if (c === 'soft' || c === '软' || c === '软字幕' || c === 'srt') return 'soft'
  if (c === 'hard' || c === '硬' || c === '硬字幕' || c === 'burn') return 'hard'
  return raw
}

/**
 * Stable short tags for gateway `tvHevcFpsEncodes` numeric sphevcfps ids
 * (order matches play_tv_persona.go — exclude default/h264).
 */
export const TENCENT_HEVC_FPS_ENCODE_TAGS: Readonly<Record<string, string>> = {
  '2741517771455': 'HEVC·A',
  '2741527771455': 'HEVC·B',
  '9741517771455': 'HEVC·C',
  '5741917771647': 'HEVC·D',
  '61111111016223': 'HEVC·E',
  '2741527771647': 'HEVC·F',
}

/** Strip soft/hard / 软/硬 suffix → persona encode key. */
export function tencentPersonaKey(persona: string): string {
  return persona.trim().replace(/_(?:软|硬|soft|hard)$/i, '')
}

/** Map persona → short Chinese/ASCII encode tag (empty for main-ladder personas). */
export function tencentEncodeTag(persona: string): string {
  const key = tencentPersonaKey(persona)
  if (!key) return ''
  const lower = key.toLowerCase()
  // Main-ladder / non-encode personas: no tag column noise.
  if (
    lower === 'l3' ||
    lower === 'source' ||
    lower === 'samsung_dolby' ||
    lower === 'phone_normal'
  ) {
    return ''
  }
  if (lower === 'default') return '默认'
  if (lower === 'h264') return 'H264'
  if (TENCENT_HEVC_FPS_ENCODE_TAGS[key]) return TENCENT_HEVC_FPS_ENCODE_TAGS[key]!
  if (/^\d+$/.test(key)) return `编码·${key.slice(-4)}`
  // Unknown non-numeric prefix — last 4 of whatever we have.
  const tail = key.replace(/\D/g, '').slice(-4) || key.slice(-4)
  return tail ? `编码·${tail}` : ''
}

/** Prefer clean sname; strip ugly `;(4K)` clutter from cname when needed. */
export function tencentQualityBaseName(raw: Record<string, unknown>, name: string): string {
  const sname = asString(raw.sname).trim()
  if (sname) return sname
  const cname = asString(raw.cname).trim()
  if (cname) {
    // cname often looks like `臻彩MAX+;(4K)` — drop the resolution suffix.
    const cleaned = cname.replace(/;\s*\([^)]*\)\s*$/u, '').trim()
    return cleaned || cname
  }
  if (name === 'source' || name === 'original') return '原画'
  return name.toUpperCase()
}

/** Display label: clean for main/default; `name · tag` for encode variants. */
export function tencentQualityDisplayLabel(
  base: string,
  group: Quality['group'],
  encodeTag: string,
  persona = '',
): string {
  const key = tencentPersonaKey(persona).toLowerCase()
  const isDefault = key === 'default' || encodeTag === '默认'
  if (group === 'main' || isDefault || !encodeTag) return base
  if (group === 'encode' || encodeTag) return `${base} · ${encodeTag}`
  return base
}

/** Audio-only formats belong on the 音轨 tab, not the quality ladder. */
export function isTencentAudioFormat(raw: Record<string, unknown>): boolean {
  const name = (asString(raw.name) || asString(raw.defn)).toLowerCase()
  if (!name) return false
  if (name === 'audio' || name === 'audioonly' || name === 'audio_only') return true
  if (name.startsWith('audio')) return true
  const media = asString(raw.media_type || raw.type).toLowerCase()
  return media === 'audio'
}

/** Fixed column widths for the quality table (header + rows share these). */
export const QUALITY_COLS = {
  mark: 2,
  label: 18,
  caption: 4,
  res: 10,
  fps: 5,
  size: 9,
  id: 6,
  encode: 6,
} as const

/** Prefer ASCII `x` so Windows Terminal width matches displayWidth (× is often 2 cells). */
export function qualityResolution(width: number, height: number): string {
  if (width > 0 && height > 0) return `${width}x${height}`
  if (height > 0) return `${height}p`
  return '—'
}

export function qualityFormatId(q: Pick<Quality, 'id' | 'formatId'>): string {
  if (q.formatId) return q.formatId
  const parts = q.id.split('|')
  if (parts.length >= 3) {
    const fid = parts[2]!
    if (fid && fid !== '0' && fid !== '-') return fid
  }
  return '—'
}

/** Map gateway play `formats[]` → Quality rows (exported for tests). Skips audio-only. */
export function qualitiesFromTencentFormats(formats: unknown): Quality[] {
  if (!Array.isArray(formats)) return []
  const out: Quality[] = []
  const seen = new Set<string>()
  for (const raw of formats) {
    if (!isObj(raw)) continue
    if (isTencentAudioFormat(raw)) continue
    const name = asString(raw.name) || asString(raw.defn)
    if (!name) continue
    const caption = tencentCaptionLabel(asString(raw.caption))
    const fid = asString(raw.id)
    const persona = asString(raw.persona)
    const group = tencentFormatGroup(raw)
    const id = [name, caption || '-', fid || '0', persona || group].join('|')
    if (seen.has(id)) continue
    seen.add(id)
    const encodeTag = tencentEncodeTag(persona)
    const base = tencentQualityBaseName(raw, name)
    const label = tencentQualityDisplayLabel(base, group, encodeTag, persona)
    const width = anyInt(raw.width)
    const height = anyInt(raw.height)
    const fps = anyInt(raw.vfps) || anyInt(raw.fps)
    const size = anyInt(raw.fs) || anyInt(raw.size)
    const hdr = asString(raw.hdr)
    const profile = asString(raw.profile)
    let codec = profile.toUpperCase()
    if (!codec && hdr) codec = hdr.toUpperCase()
    if (!codec && /hevc|h265|hvc/i.test(asString(raw.vencoding) + asString(raw.codec))) codec = 'H265'
    out.push({
      id,
      label,
      title: name,
      size,
      width,
      height,
      codec: codec || '—',
      drm: asString(raw.drm) || (anyInt(raw.lmt) > 0 ? 'DRM' : ''),
      tier: height || tencentDefnRank(name),
      caption: caption || undefined,
      fps: fps > 0 ? fps : undefined,
      stream: name,
      formatId: fid || undefined,
      fname: asString(raw.fname) || asString(raw.sname) || undefined,
      group,
      persona: persona || undefined,
      encodeTag: encodeTag || undefined,
    })
  }
  return sortTencentQualities(out)
}

/** Build 音轨 rows from gateway `audio_tracks` or audio-only `formats[]`. */
export function audiosFromTencent(data: Record<string, unknown>): Audio[] {
  const out: Audio[] = []
  const seen = new Set<string>()
  const add = (id: string, label: string, lang: string, codec: string, isDefault: boolean) => {
    const key = id || label
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push({
      id: key,
      label: label || key,
      lang: lang || '原声',
      codec: codec || '',
      isDefault,
      selected: true,
    })
  }

  const tracks = Array.isArray(data.audio_tracks) ? data.audio_tracks : []
  for (const tr of tracks) {
    if (!isObj(tr)) continue
    const id = asString(tr.id) || asString(tr.name)
    const label = asString(tr.cname) || asString(tr.sname) || asString(tr.name) || id
    if (!id && !label) continue
    add(id || label, label, asString(tr.lang) || asString(tr.name), asString(tr.name), out.length === 0)
  }
  if (out.length) {
    if (!out.some((a) => a.isDefault)) out[0]!.isDefault = true
    return out
  }

  const formats = Array.isArray(data.formats) ? data.formats : []
  for (const raw of formats) {
    if (!isObj(raw) || !isTencentAudioFormat(raw)) continue
    const fid = asString(raw.id) || 'audio'
    const caption = tencentCaptionLabel(asString(raw.caption))
    const cname = asString(raw.cname) || asString(raw.sname) || '音轨'
    const softHard = caption === 'soft' ? '软' : caption === 'hard' ? '硬' : ''
    const label = softHard ? `${cname}（${softHard}）` : cname
    const lang = softHard || asString(raw.lang) || '原声'
    const codec = asString(raw.profile) || asString(raw.codec) || asString(raw.name) || 'audio'
    const id = [fid, caption || '-', asString(raw.persona) || 'audio'].join('|')
    add(id, label, lang, codec, out.length === 0)
  }
  if (out.length && !out.some((a) => a.isDefault)) out[0]!.isDefault = true
  return out
}

/** main soft/hard ladder (hi→lo) → encode extras → source last; pair soft/hard by name. */
export function sortTencentQualities(rows: Quality[]): Quality[] {
  const groupRank = (g: Quality['group']) => (g === 'main' ? 0 : g === 'encode' ? 1 : 2)
  const capRank = (c?: string) => (c === 'soft' ? 0 : c === 'hard' ? 1 : 2)
  return [...rows].sort((a, b) => {
    const ga = groupRank(a.group)
    const gb = groupRank(b.group)
    if (ga !== gb) return ga - gb
    const ra = tencentDefnRank(a.stream || a.title || a.id)
    const rb = tencentDefnRank(b.stream || b.title || b.id)
    if (ra !== rb) return rb - ra
    const na = (a.stream || a.title).toLowerCase()
    const nb = (b.stream || b.title).toLowerCase()
    if (na !== nb) return na < nb ? -1 : 1
    const ca = capRank(a.caption)
    const cb = capRank(b.caption)
    if (ca !== cb) return ca - cb
    return (b.fps || 0) - (a.fps || 0) || (b.size || 0) - (a.size || 0)
  })
}

async function probeTencent(cli: GwClient, cfg: FileConfig, vid: string): Promise<StreamOptions> {
  const input: Record<string, string> = {
    vid,
    // Catalog: always ask soft+hard and include 原画 when the account can unlock it.
    caption: 'all',
    source: '1',
    ...tencentPlayInput(cfg),
  }
  // encode=all is STRICTLY opt-in (风控); never default on.
  if (cfg.tencentEncodeAll) input.encode = 'all'
  const data = await cli.invoke('tencent', 'play', input, cli.extra(cfg, 'tencent'))
  const qualities = qualitiesFromTencentFormats(data.formats)
  const audios = audiosFromTencent(data)
  if (!qualities.length) return { qualities: tencentQualityList(), audios }
  return { qualities, audios }
}

/** Build play params for a selected Tencent quality / pending task. */
export function tencentPlayQualityInput(q: {
  quality?: string
  stream?: string
  caption?: string
  group?: string
  needSource?: boolean
}): Record<string, string> {
  const stream = (q.stream || q.quality || 'fhd').trim()
  const out: Record<string, string> = {}
  if (stream === 'source' || q.group === 'source' || q.needSource) {
    out.source = '1'
    // Primary ladder still needs a defn; uhd is the friend/source companion ladder.
    out.defn = 'uhd'
  } else {
    out.defn = stream.includes('|') ? stream.split('|')[0]! : stream
  }
  const cap = (q.caption || '').toLowerCase()
  if (cap === 'soft' || cap === 'hard') out.caption = cap
  return out
}

function hongguoCodec(value: unknown): string {
 const codec = asString(value).toLowerCase()
 if (/^(hevc|h265|h265_hvc1|hvc1|hev1)$/.test(codec)) return 'H265'
 if (/^(h264|avc1|avc)$/.test(codec)) return 'H264'
 return codec.toUpperCase()
}

export function hongguoStreamOptions(data: Record<string, unknown>, vid: string): StreamOptions {
 const item = hongguoItem(data, vid)
 const picked = pickHongguo(data, vid, '')
 if (!picked.cdn) throw new Error(picked.why || '红果没有可用视频地址')
 const streams = Array.isArray(item.streams) ? item.streams.filter(isObj).filter(s => asString(s.url)) : []
 const qualities: Quality[] = streams.map(s => {
   const quality = asString(s.quality)
   const codec = hongguoCodec(s.codec)
   const audio = isObj(s.audio) ? s.audio : {}
   const audioCodec = asString(audio.codec).toUpperCase()
   const profile = asString(audio.profile)
   const channels = anyInt(audio.channels)
   const sampleRate = anyInt(audio.sample_rate)
   const bitrate = anyInt(audio.bitrate)
   const label = [audioCodec || '编码未提供', profile, channels ? `${channels}声道` : '', sampleRate ? `${sampleRate/1000}kHz` : '', bitrate ? `${Math.round(bitrate/1000)}kbps` : ''].filter(Boolean).join(' ')
   const audios: Audio[] = [{id:'embedded',label,lang:asString(audio.language) || '未提供',codec:audioCodec,isDefault:true,selected:true,embedded:true}]
   const height = anyInt(s.height) || Number(/^(\d+)p$/i.exec(quality)?.[1] || 0)
   return {tier:Number(/^(\d+)p$/i.exec(quality)?.[1] || 0),id:asString(s.id) || quality,label:quality || '分辨率未提供',title:quality || '分辨率未提供',width:anyInt(s.width),height,codec,size:anyInt(s.size),drm:asString(s.key) ? 'CENC' : '',audios}
 })
 if (!qualities.length) qualities.push({id:'',label:'默认流',title:'默认流（网关未提供媒体信息）',size:0,width:0,height:0,codec:'',drm:picked.key?'CENC':'',audios:[{id:'embedded',label:'编码未提供',lang:'未提供',codec:'',isDefault:true,selected:true,embedded:true}]})
 return { qualities, audios: qualities[0].audios ?? [] }
}

async function probeHongguo(cli: GwClient, vid: string): Promise<StreamOptions> {
 return hongguoStreamOptions(await cli.invoke('hongguo', 'resolve', hongguoResolveInput(vid)), vid)
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
  opts: { skipSign?: boolean; languages?: Array<{ vid: string; lang: string }> } = {},
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

  const extraVids: string[] = []
  const langByVid: Record<string, string> = {}
  const addVid = (extraVid: string, lang = '') => {
    if (!extraVid) return
    if (lang && !langByVid[extraVid]) langByVid[extraVid] = lang
    if (extraVid === vid || extraVids.includes(extraVid)) return
    extraVids.push(extraVid)
  }
  for (const it of youkuLanguageRefs(data)) addVid(it.vid, it.lang)
  for (const it of opts.languages ?? []) addVid(it.vid, it.lang)
  const extras: Array<{ vid: string; data: Record<string, unknown>; lang?: string }> = []
  for (const extraVid of extraVids) {
    try {
      extras.push({
        vid: extraVid,
        data: await cli.invoke('youku', 'play', { vid: extraVid, tier: 'multi', expand: '0' }, cli.extra(cfg, 'youku', opts.skipSign)),
        lang: langByVid[extraVid],
      })
    } catch (e) {
      if (e instanceof ReloginRequired) throw e
    }
  }
  const audios = extras.length
    ? youkuMergeEditionAudios(vid, data, extras)
    : youkuAudiosFromPlay(data, vid, langByVid[vid] || youkuLangForVid(data, vid))

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
