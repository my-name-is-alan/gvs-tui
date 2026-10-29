import type { Audio, Quality, Subtitle } from '../types.ts'
import type { FileConfig } from './config.ts'
import type { GwClient } from './client.ts'
import { asBool, isObj } from './util.ts'
import { tierHeight } from './name.ts'
import { mediaDownloadProxy } from './proxy.ts'
import { chineseVariant, onlineSubtitles, type OnlineSubtitle } from './online-subtitles.ts'

/** 需要固定出口的源（目前只有 Crunchyroll）把媒体请求也走配置的代理。 */
export function manifestDownloadProxy(provider: string, cfg: Pick<FileConfig, 'gatewayProxy'>): string {
  return provider === 'crunchyroll' ? mediaDownloadProxy(cfg.gatewayProxy) : ''
}

export type ManifestSource = { url: string; headers: Record<string, string>; format: string; height: number; quality: string; clear: boolean; drm: string; live: boolean; contentKeys: string[]; manifest?: string; subtitles?: OnlineSubtitle[] }
const str = (v: unknown): string => typeof v === 'string' ? v : ''
export function manifestSources(data: Record<string, unknown>): ManifestSource[] {
  const raw = isObj(data.raw) ? data.raw : {}
  const rows = Array.isArray(data.media) ? data.media : Array.isArray(raw.media) ? raw.media : []
  // Crunchyroll 的字幕是源站单独的签名直链，不在清单里：随 resolve 一起带走。
  const subtitles = onlineSubtitles(data)
  return rows.filter(isObj).filter(m => !m.type || m.type === 'video').map(m => {
    const meta = isObj(m.meta) ? m.meta : {}
    const drm = isObj(m.drm) ? m.drm : isObj(meta.drm) ? meta.drm : isObj(data.drm) ? data.drm : isObj(raw.drm) ? raw.drm : {}
    const h = isObj(m.headers) ? m.headers : isObj(meta.headers) ? meta.headers : isObj(data.headers) ? data.headers : {}
    const headers = Object.fromEntries(Object.entries(h).filter(([k,v]) => typeof v === 'string' && ![k,v].some(s => s.includes(String.fromCharCode(13)) || s.includes(String.fromCharCode(10))))) as Record<string,string>
    const url = str(m.url); let safe = false
    try { const u = new URL(url); safe = ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password } catch {}
    const contentKeys = parseContentKeys(drm.contentKeys)
    const manifest = str(data.manifest || raw.manifest) || undefined
    return { url: safe ? url : '', headers, format: str(m.format || meta.format), quality: str(m.quality || meta.quality), height: Number(m.height || meta.height) || 0, clear: drm.clear === true, drm: str(drm.system) || (drm.clear === true ? 'none' : 'unknown'), live: m.isLive === true || data.isLive === true || raw.isLive === true, contentKeys, manifest, ...(subtitles.length ? { subtitles } : {}) }
  }).filter(m => !!m.url)
}
export function manifestInput(provider: string, cfg: Pick<FileConfig, 'hamiClient'>, id: string, quality = 'auto'): Record<string, unknown> {
  // Disney+: a title page is entity-…; an episode/movie plays by its mediaId (resourceId). The default tier is L1 (ctr-high); no level is sent, so no downgrade.
  if (provider === 'dsnp') {
    if (id.startsWith('entity-')) return { id }
    const m = id.match(/^(.+)\|(imax|widescreen)$/)
    return m ? { mediaId: m[1], version: m[2] } : { mediaId: id }
  }
  return { ...(provider === 'appletvplus' && id.startsWith('https://') ? {url:id} : {id}), ...(provider === 'hamivideo' ? { client: cfg.hamiClient || 'tv', quality } : provider === 'friday' || provider === 'appletvplus' ? { quality } : {}) }
}
export async function resolveManifest(cli: Pick<GwClient, 'invoke'>, cfg: Pick<FileConfig, 'hamiClient'>, provider: string, id: string, quality = 'auto'): Promise<ManifestSource[]> {
  const data = await cli.invoke(provider, 'resolve', manifestInput(provider, cfg, id, quality))
  const sources = manifestSources(data)
  if (!sources.length) throw new Error('网关没有返回可用媒体清单')
  return sources
}
const positive = (value: unknown): number => {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Catalog bytes win. Otherwise estimate from this rendition's bitrate and a known duration. */
export function appleTVQualitySize(row: Record<string, unknown>, episodeDuration = 0): { size: number; estimated: boolean } {
  const bytes = positive(row.size) || positive(row.estimatedSize) || positive(row.fileSize) || positive(row.fs)
  if (bytes) return { size: bytes <= Number.MAX_SAFE_INTEGER ? Math.round(bytes) : 0, estimated: false }
  const duration = positive(row.duration) || positive(row.durationSec) || positive(episodeDuration)
  const kbps = positive(row.bitrateKbps) || positive(row.videoBitrateKbps)
  const bps = kbps ? kbps * 1000 : positive(row.bitrate) || positive(row.bandwidth) || positive(row.averageBitrate) || positive(row.avgBitrate)
  if (!bps || !duration) return { size: 0, estimated: false }
  const estimated = bps * duration / 8
  if (!Number.isFinite(estimated) || estimated > Number.MAX_SAFE_INTEGER) return { size: 0, estimated: false }
  return { size: Math.round(estimated), estimated: true }
}

export async function probeManifest(cli: GwClient, cfg: FileConfig, provider: string, id: string, episodeDuration = 0): Promise<{ qualities: Quality[]; audios: Audio[]; subtitles?: Subtitle[] }> {
  if (provider === 'appletvplus') {
    const data = await cli.invoke(provider, 'probe', manifestInput(provider, cfg, id))
    const rows = Array.isArray(data.qualities) ? data.qualities.filter(isObj) : []
    const qualities: Quality[] = rows.filter(q => str(q.id) && Number(q.height) > 0).map(q => {
      const sized = appleTVQualitySize(q, episodeDuration)
      const label = str(q.label)
      const range = str(q.hdr) || str(q.dynamicRange) || str(q.videoRange) || str(q.id).split('|')[2] || ''
      return { id: str(q.id), label, title: sized.estimated ? `${label} · 体积按码率和时长估算` : label, size: sized.size, duration: positive(q.duration) || positive(episodeDuration) || undefined, width: Number(q.width) || 0, height: Number(q.height), codec: str(q.codec), drm: 'playready', stream: str(q.id), hdr: range, fps: Number(q.fps) || undefined, tier: tierHeight(Number(q.width) || 0, Number(q.height)) }
    })
    if (!qualities.length) throw new Error('Apple TV 没有返回可用画质')
    // Apple TV 一片多配音、多字幕；网关按 1-based 序号标识，下载时原样传回，
    // 由网关只把选中的渲染写进 master（它们的 URI 都叫 stream/playlist.m3u8）。
    const audios: Audio[] = (Array.isArray(data.audios) ? data.audios : []).filter(isObj).map((a, i) => ({
      id: str(a.id) || String(i + 1),
      label: str(a.name) || str(a.language) || `音轨 ${i + 1}`,
      lang: str(a.language),
      codec: '',
      isDefault: asBool(a.default),
      // Apple marks main audio and audio description DEFAULT=YES alike; only the
      // main track may be preselected or every download muxes a second AD track.
      audioDescription: asBool(a.audioDescription),
      selected: (asBool(a.default) && !asBool(a.audioDescription)) || i === 0,
    }))
    const subtitles: Subtitle[] = (Array.isArray(data.subtitles) ? data.subtitles : []).filter(isObj).map((s, i) => ({
      id: str(s.id) || String(i + 1),
      label: str(s.name) || str(s.language) || `字幕 ${i + 1}`,
      lang: str(s.language),
      forced: false,
      sdh: false,
      isDefault: asBool(s.default),
      selected: asBool(s.default),
    }))
    return { qualities, audios, subtitles }
  }
  if (provider === 'crunchyroll') return probeCrunchyroll(cli, id)
  if (provider === 'dsnp') return probeDsnp(cli, cfg, id)
  const sources = await resolveManifest(cli, cfg, provider, id)
  return { qualities: sources.map(s => {
    const selectable = provider === 'friday' ? [1080,2160].includes(s.height) : provider === 'hamivideo' && cfg.hamiClient !== 'web' && [480,720,1080,2160].includes(s.height)
    return { id: selectable ? String(s.height) : 'auto', label: s.quality || (s.height ? `${s.height}p` : '自动'), title: s.clear ? '源站明确标记明文 · 本机直连下载' : ['hamivideo', 'friday', 'dsnp'].includes(provider) ? '网关授权取内容密钥 · 本机下载解密' : '受保护媒体 · 当前客户端尚未接入该 DRM 授权处理', size: 0, width: 0, height: s.height, codec: '', drm: s.clear ? 'none' : s.drm, stream: selectable ? String(s.height) : 'auto', tier: tierHeight(0, s.height) }
  }), audios: [] }
}

/**
 * Crunchyroll 画质：网关 `qualities` 只读源站 DASH 清单、不换钥也不计费，
 * 所以能在选片阶段就列出真实档位（分辨率/码率/帧率/音轨）。
 * 旧网关没有这个动作，或本次探测失败时，退回单条「自动（最佳画质）」——
 * 下载本身由下载器在同一条清单里自选，不会因此下不了。
 */
export async function probeCrunchyroll(cli: Pick<GwClient, 'invoke'>, id: string): Promise<{ qualities: Quality[]; audios: Audio[] }> {
  try {
    const data = await cli.invoke('crunchyroll', 'qualities', { id })
    const rows = Array.isArray(data.qualities) ? data.qualities.filter(isObj) : []
    const qualities: Quality[] = rows.map(q => {
      const height = Number(q.height) || 0
      const width = Number(q.width) || 0
      const kbps = Math.round(Number(q.bitrateKbps) || 0)
      const codec = str(q.codec)
      const id = str(q.id) || (height ? `${height}p` : '')
      const label = str(q.label) || (height ? `${height}p` : id)
      const bits = [kbps ? `${kbps} kbps` : '', codec].filter(Boolean).join(' · ')
      return {
        id: id || 'auto',
        label,
        title: bits ? `DASH · 本机直连 CDN · ${bits}` : 'DASH · 本机直连 CDN',
        size: 0,
        width,
        height,
        codec,
        drm: 'widevine',
        stream: str(q.stream) || id || 'auto',
        fps: Number(q.fps) || undefined,
        tier: tierHeight(width, height),
      }
    }).filter(q => q.height > 0 || q.id === 'auto')
    if (!qualities.length) throw new Error('网关没有返回可用档位')
    // 配音：CR 的每一档配音是另一条 episode 版本，网关按 locale 换版本 id。
    const audioRows = Array.isArray(data.audios) ? data.audios.filter(isObj) : []
    const audios: Audio[] = audioRows.map((a, i) => {
      const locale = str(a.lang) || str(a.locale) || str(a.id)
      const base = str(a.label) || locale || `音轨 ${i + 1}`
      const original = asBool(a.original)
      return {
        id: str(a.id) || locale || String(i + 1),
        label: original && locale && !/原声/.test(base) ? `${base}（原声）` : base,
        lang: locale,
        codec: str(a.codec),
        isDefault: asBool(a.default) || i === 0,
        selected: asBool(a.default) || i === 0,
      }
    })
    // 字幕：源站给的是独立签名直链。默认勾选简体中文 + 繁体中文（都勾上），
    // 并把简体标为默认显示；没有中文字幕时才退回英语。
    const subRows = onlineSubtitles(data)
    const subtitles: Subtitle[] = subRows.map(s => ({
      id: s.id,
      label: s.label,
      lang: s.lang,
      forced: false,
      sdh: false,
      selected: false,
      isDefault: false,
    }))
    const hans = subtitles.filter(s => chineseVariant(s.lang, s.label, s.id) === 'hans')
    const hant = subtitles.filter(s => chineseVariant(s.lang, s.label, s.id) === 'hant')
    const chinese = [...hans, ...hant]
    if (chinese.length) {
      for (const s of chinese) s.selected = true
      const preferred = hans[0] ?? hant[0]!
      preferred.isDefault = true
    } else {
      const english = subtitles.find(s => /^en\b/i.test(s.lang))
      if (english) { english.selected = true; english.isDefault = true }
    }
    return { qualities, audios, ...(subtitles.length ? { subtitles } : {}) }
  } catch (e) {
    // 旧网关 / 探测失败：保留原来的单入口，下载照旧走最佳画质。
    // 但「账号并发播放会话已满」必须让用户看见——否则画质页只剩一条「自动」，
    // 看起来像"不显示画质列表"，实际是 CR 上游返回 420（网关转成 429）。
    const code = (e as { errorCode?: string } | null)?.errorCode || ''
    const status = (e as { httpStatus?: number } | null)?.httpStatus
    if (code === 'TOO_MANY_QUEUED_STREAMS' || status === 429) throw e
  }
  return { qualities: [{ id: 'auto', label: '自动（最佳画质）', title: 'DASH · 本机直连 CDN', size: 0, width: 0, height: 0, codec: '', drm: 'widevine', stream: 'auto', tier: 0 }], audios: [] }
}

type HlsAttrs = Record<string, string>
function hlsAttrs(line: string): HlsAttrs {
  const out: HlsAttrs = {}
  for (const m of line.slice(line.indexOf(':') + 1).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]!] = m[2]!.replace(/^"|"$/g, '')
  return out
}
const uriKey = (uri: string): string => uri.split('?')[0]!.split('/').pop() || ''
type DsnpVideoKind = 'dv' | 'hdr' | 'sdr'
const KIND_LABEL: Record<DsnpVideoKind, string> = { dv: 'DV', hdr: 'HDR10', sdr: 'SDR' }
/** RE --select-video codecs filter per kind (the master tags DV as dvh1, HDR10 as hvc1, SDR as avc1). */
export const DSNP_VIDEO_CODECS: Record<DsnpVideoKind, string> = { dv: 'dvh1|dvhe', hdr: 'hvc1|hev1', sdr: 'avc1' }
/** Active picture inside the 16:9 container (Disney+ letterboxes 2.39 and IMAX 1.90 into 3840x2160). */
export function activePicture(width: number, height: number, ratio: number): { width: number; height: number } | undefined {
  if (!(ratio > 0) || !width || !height || Math.abs(width / height - ratio) < 0.02) return undefined
  return ratio > width / height ? { width, height: Math.round(width / ratio / 2) * 2 } : { width: Math.round(height * ratio / 2) * 2, height }
}

/** Disney+ HLS master → one quality per height × dynamic range (DV / HDR10 / SDR). Size = video bitrate × duration (estimate). */
export function hlsMasterQualities(text: string, opts: { durationSec?: number; aspectRatio?: number; audioBitrate?: number } = {}): Quality[] {
  const lines = text.split(/\r?\n/)
  // Per video playlist: the lowest AVERAGE-BANDWIDTH across its variants is video + the smallest audio group.
  const rows = new Map<string, { width: number; height: number; kind: DsnpVideoKind; codec: string; fps: number; avg: number; minAudio: number }>()
  const audioKbps = new Map<string, number>()
  for (const line of lines) if (line.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(line)) {
    const a = hlsAttrs(line); const k = Number(/_(\d+)k_/.exec(a.URI || '')?.[1]) || 0
    if (a['GROUP-ID'] && k) audioKbps.set(a['GROUP-ID'], Math.min(audioKbps.get(a['GROUP-ID']) ?? Infinity, k))
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue
    const a = hlsAttrs(line)
    const res = /^(\d+)x(\d+)$/.exec(a.RESOLUTION || '')
    const tag = (a.CODECS || '').split(',').map(c => c.trim()).find(c => /^(hvc1|hev1|dvh1|dvhe|avc1)/.test(c))
    if (!res || !tag) continue
    const width = Number(res[1]), height = Number(res[2])
    const kind: DsnpVideoKind = /^(dvh1|dvhe)/.test(tag) ? 'dv' : a['VIDEO-RANGE'] === 'PQ' || a['VIDEO-RANGE'] === 'HLG' ? 'hdr' : 'sdr'
    const avg = Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0
    const audio = (audioKbps.get(a.AUDIO || '') ?? 0) * 1000
    const video = Math.max(0, avg - audio)
    const key = `${height}:${kind}:${uriKey(lines[i + 1] || '')}`
    const prev = rows.get(key)
    if (!prev || video < prev.avg) rows.set(key, { width, height, kind, codec: tag.split('.')[0]!, fps: Number(a['FRAME-RATE']) || 0, avg: video, minAudio: audio })
  }
  // Best (highest bitrate) playlist per height × kind; that is what RE's for=best picks inside the filter.
  const best = new Map<string, { width: number; height: number; kind: DsnpVideoKind; codec: string; fps: number; avg: number }>()
  for (const r of rows.values()) {
    const k = `${r.height}:${r.kind}`
    if (!best.has(k) || r.avg > best.get(k)!.avg) best.set(k, r)
  }
  const order: DsnpVideoKind[] = ['dv', 'hdr', 'sdr']
  return [...best.values()].sort((a, b) => b.height - a.height || order.indexOf(a.kind) - order.indexOf(b.kind)).map(r => {
    const tier = r.height >= 2160 ? '4K' : `${r.height}p`
    const pic = activePicture(r.width, r.height, opts.aspectRatio || 0)
    const imax = (opts.aspectRatio || 0) > 1.85 && (opts.aspectRatio || 0) < 1.95
    const ratio = opts.aspectRatio ? `${opts.aspectRatio.toFixed(2)}:1${imax ? ' IMAX' : ''}` : ''
    const size = opts.durationSec ? Math.round((r.avg + (opts.audioBitrate || 0)) * opts.durationSec / 8) : 0
    const codecName = r.kind === 'dv' ? 'Dolby Vision (HEVC)' : r.codec === 'avc1' ? 'H.264' : 'HEVC'
    return { id: `${r.height}:${r.kind}`, label: `${tier} ${KIND_LABEL[r.kind]}${imax ? ' · IMAX' : ''}`,
      title: `网关授权取内容密钥 · 本机下载解密 · ${codecName} · 平均 ${(r.avg / 1e6).toFixed(1)} Mbps${pic ? ` · 实际画面 ${pic.width}×${pic.height}（${ratio}，片源上下黑边）` : ratio ? ` · ${ratio}` : ''}${size ? ' · 体积按平均码率估算' : ''}`,
      size, width: r.width, height: r.height, codec: r.codec, drm: 'widevine', stream: `${r.height}:${r.kind}`, hdr: r.kind === 'dv' ? 'DV' : r.kind === 'hdr' ? 'HDR' : '', fps: r.fps || undefined, tier: tierHeight(r.width, r.height) }
  })
}

const LANG_NAME: Record<string, string> = { cmn: '国语', yue: '粤语', zh: '中文', en: '英语', ja: '日语', ko: '韩语', fr: '法语', de: '德语', es: '西班牙语', it: '意大利语', pt: '葡萄牙语', th: '泰语' }
/** Disney+ master EXT-X-MEDIA audio → selectable tracks (id = the rendition playlist file, unique across groups). */
export function hlsMasterAudios(text: string): Audio[] {
  const seen = new Map<string, Audio & { kbps: number; primary: boolean }>()
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-MEDIA:') || !/TYPE=AUDIO/.test(line)) continue
    const a = hlsAttrs(line)
    const id = uriKey(a.URI || '')
    if (!id || seen.has(id)) continue
    const lang = a.LANGUAGE || ''
    const atmos = /JOC/i.test(a.CHANNELS || '')
    const ch = atmos ? 6 : Number.parseInt(a.CHANNELS || '', 10) || 2
    const kbps = Number(/_(\d+)k_/.exec(id)?.[1]) || 0
    const codec = /dtsx/i.test(id) ? 'DTS:X' : /ec-3/i.test(id) ? 'E-AC-3' : /mp4a/i.test(id) ? 'AAC' : (a['GROUP-ID'] || '')
    const chText = codec === 'DTS:X' ? '' : ch >= 8 ? '7.1' : ch >= 6 ? '5.1' : ch === 1 ? '1.0' : '2.0'
    const ad = /NARRATION|describes-video/i.test(`${id} ${a.CHARACTERISTICS || ''}`)
    const base = lang.split('-')[0]!
    const label = `${LANG_NAME[lang] || LANG_NAME[base] || a.NAME || lang}${ad ? '（口述影像）' : ''} · ${codec}${chText ? ` ${chText}` : ''}${atmos ? ' Atmos' : ''}${kbps ? ` · ${kbps}k` : ''}`
    seen.set(id, { id, label, lang, codec, isDefault: false, selected: false, kbps, primary: !ad })
  }
  const rows = [...seen.values()]
  const score = (r: { codec: string; label: string; kbps: number }) => (/Atmos/.test(r.label) ? 4e6 : r.codec === 'E-AC-3' ? 3e6 : r.codec === 'AAC' ? 2e6 : 1e6) + r.kbps
  // Original language: the language of the richest primary track (Atmos/DTS:X are only mastered for the original mix).
  const top = rows.filter(r => r.primary).sort((a, b) => score(b) - score(a))[0]
  const want = new Set([top?.lang, 'cmn', 'yue', 'zh', 'zh-Hans', 'zh-Hant', 'zh-HK', 'zh-TW'].filter(Boolean) as string[])
  for (const lang of want) {
    const pick = rows.filter(r => r.primary && r.lang === lang && r.codec !== 'DTS:X').sort((a, b) => score(b) - score(a))[0]
    if (pick) pick.selected = true
  }
  const chinese = rows.find(r => r.selected && /^(cmn|yue|zh)/.test(r.lang))
  const def = chinese ?? rows.find(r => r.selected)
  if (def) def.isDefault = true
  return rows.sort((a, b) => Number(b.selected) - Number(a.selected) || Number(b.primary) - Number(a.primary) || a.lang.localeCompare(b.lang) || score(b) - score(a))
    .map(({ kbps: _k, primary: _p, ...r }) => r)
}

const SUB_LANG: Record<string, string> = { 'zh-Hans': '简体中文', 'zh-CN': '简体中文', 'zh-Hant': '繁体中文', 'zh-TW': '繁体中文（台湾）', 'zh-HK': '繁体中文（香港）', cmn: '国语', yue: '粤语', zh: '中文', en: '英语', ja: '日语', ko: '韩语' }
const isChineseLang = (l: string) => /^(zh|cmn|yue)(-|$)/i.test(l)
/**
 * Disney+ master EXT-X-MEDIA subtitles → selectable tracks (deduped by rendition file).
 * Default: 简体/繁体中文 + the original language (full), plus forced tracks for every selected audio language.
 */
export function hlsMasterSubtitles(text: string, audioLangs: string[] = [], originalLang = ''): Subtitle[] {
  const seen = new Map<string, Subtitle>()
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-MEDIA:') || !/TYPE=SUBTITLES/.test(line)) continue
    const a = hlsAttrs(line)
    const id = uriKey(a.URI || '')
    if (!id || seen.has(id)) continue
    const lang = a.LANGUAGE || ''
    const forced = a.FORCED === 'YES' || /--forced--/i.test(a.NAME || '')
    const sdh = /describes-music-and-sound/.test(a.CHARACTERISTICS || '') || /\[(CC|SDH)\]/i.test(a.NAME || '')
    const base = lang.split('-')[0]!
    const name = SUB_LANG[lang] || SUB_LANG[base] || (a.NAME || lang).replace(/--forced--/i, '').trim()
    seen.set(id, { id, lang, forced, sdh, selected: false, isDefault: false, label: `${name}${forced ? '（强制）' : ''}${sdh ? '（SDH 听障）' : ''}` })
  }
  const rows = [...seen.values()]
  const same = (a: string, b: string) => !!a && !!b && (a === b || a.split('-')[0] === b.split('-')[0] || (isChineseLang(a) && isChineseLang(b)))
  // Full Chinese: simplified first, then traditional (one each); then original language (prefer non-SDH).
  for (const want of [[/^zh-(Hans|CN)$/i], [/^zh-Hant$/i, /^zh-TW$/i, /^zh-HK$/i]]) {
    const pick = want.map(re => rows.find(r => !r.forced && re.test(r.lang))).find(Boolean)
    if (pick) pick.selected = true
  }
  if (originalLang && !isChineseLang(originalLang)) {
    const pick = rows.filter(r => !r.forced && same(r.lang, originalLang)).sort((a, b) => Number(a.sdh) - Number(b.sdh))[0]
    if (pick) pick.selected = true
  }
  for (const r of rows) if (r.forced && audioLangs.some(l => same(r.lang, l))) r.selected = true
  const def = rows.find(r => r.selected && !r.forced && /^zh-(Hans|CN)$/i.test(r.lang)) ?? rows.find(r => r.selected && !r.forced && isChineseLang(r.lang))
  if (def) def.isDefault = true
  // Playlist order on purpose: RE muxes in this order and the MKV flags are matched by position.
  return rows
}

async function hlsDurationSec(master: string, base: string, headers: Record<string, string>): Promise<number> {
  // The smallest video playlist lists the same timeline as every rendition.
  const lines = master.split(/\r?\n/)
  const i = lines.findIndex(l => l.startsWith('#EXT-X-STREAM-INF:'))
  if (i < 0 || !lines[i + 1]) return 0
  const res = await fetch(new URL(lines[i + 1]!, base), { headers, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) return 0
  let total = 0
  for (const m of (await res.text()).matchAll(/^#EXTINF:([\d.]+)/gm)) total += Number(m[1])
  return total
}

async function probeDsnp(cli: GwClient, cfg: FileConfig, id: string): Promise<{ qualities: Quality[]; audios: Audio[]; subtitles: Subtitle[] }> {
  // One billed resolve per title (and version) per 6h; the download in the same window is not charged again.
  // The version travels in the id (mediaId|imax), so each version is probed from its own playlist.
  const data = await cli.invoke('dsnp', 'resolve', manifestInput('dsnp', cfg, id))
  const sources = manifestSources(data)
  if (!sources.length) throw new Error('网关没有返回可用媒体清单')
  const source = sources[0]!
  const raw = isObj(data.raw) ? data.raw : {}
  const aspectRatio = Number(data.imageAspectRatio ?? raw.imageAspectRatio) || 0
  let qualities: Quality[] = [], audios: Audio[] = [], subtitles: Subtitle[] = []
  try {
    const res = await fetch(source.url, { headers: source.headers, signal: AbortSignal.timeout(20_000) })
    if (res.ok) {
      const text = await res.text()
      audios = hlsMasterAudios(text)
      // The richest selected track is the original mix (see hlsMasterAudios); Chinese is chosen on top of it.
      const original = audios.find(a => a.selected && !isChineseLang(a.lang))?.lang || ''
      subtitles = hlsMasterSubtitles(text, audios.filter(a => a.selected).map(a => a.lang), original)
      let durationSec = 0
      try { durationSec = await hlsDurationSec(text, source.url, source.headers) } catch {}
      const audioBitrate = audios.filter(a => a.selected).reduce((n, a) => n + (Number(/· (\d+)k$/.exec(a.label)?.[1]) || 0) * 1000, 0)
      qualities = hlsMasterQualities(text, { durationSec, aspectRatio, audioBitrate })
    }
  } catch {}
  if (!qualities.length) qualities = [{ id: 'auto', label: '最高画质', title: '网关授权取内容密钥 · 本机下载解密', size: 0, width: 0, height: 0, codec: '', drm: 'widevine', stream: 'auto', tier: tierHeight(0, 0) }]
  return { qualities, audios, subtitles }
}

export function parseContentKeys(value: unknown): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 128) throw new Error('网关返回的内容密钥集合无效')
  const keys = new Map<string, string>()
  for (const row of value) {
    if (!isObj(row) || !/^[a-f\d]{32}$/i.test(str(row.kid)) || !/^[a-f\d]{32}$/i.test(str(row.key))) throw new Error('网关返回的内容密钥格式无效')
    const kid = str(row.kid).toLowerCase(), key = str(row.key).toLowerCase()
    if (keys.has(kid) && keys.get(kid) !== key) throw new Error('网关返回了互相冲突的内容密钥')
    keys.set(kid, key)
  }
  return [...keys].map(([kid, key]) => `${kid}:${key}`)
}

export async function resolveManifestDownload(cli: Pick<GwClient, 'invoke'>, cfg: Pick<FileConfig, 'hamiClient' | 'crunchyrollToken' | 'crunchyrollSession'>, provider: string, id: string, quality = 'auto', selection?: { audio?: string[]; subtitle?: string[] }): Promise<ManifestSource[]> {
  const input = manifestInput(provider, cfg, id, quality)
  if (provider === 'appletvplus' && selection) {
    // 序号取自 probe；网关据此裁剪 master，RE 只需 --select-audio best。
    if (selection.audio?.length) input.audio = selection.audio.join(',')
    if (selection.subtitle?.length) input.subtitle = selection.subtitle.join(',')
  }
  if (provider === 'crunchyroll') {
    // 网关只换钥并发放短期 token；媒体由本机直连 CDN（不过网关带宽）。
    // 网页会话（etp_rt）优先：SSO 设备授权已失效时这是唯一可自动拿到的登录态。
    const session = (cfg.crunchyrollSession || '').trim()
    const token = (cfg.crunchyrollToken || '').trim()
    if (!session && !token) throw new Error('CRUNCHYROLL_TOKEN_REQUIRED: 请先在设置里自动登录 CR 网页会话，或导入 refresh_token')
    input.download = true
    if (session) input.session = session
    else input.refresh_token = token
    // 配音是另一条 episode 版本：只认第一档（网关按 locale 换成版本 id 再取流）。
    const audio = selection?.audio?.find(a => !!a)
    if (audio) input.audio = audio
  }
  if (provider === 'hamivideo' || provider === 'friday' || provider === 'appletvplus' || provider === 'dsnp') input.download = true
  const sources = manifestSources(await cli.invoke(provider, 'resolve', input, undefined, { timeoutMs: 120_000 }))
  if (!sources.length) throw new Error('网关没有返回可用媒体清单')
  for (const source of sources) {
    if (source.live) throw new Error('直播录制尚未接入；不会启动无限下载')
    if (source.clear) continue
    const supported = provider === 'appletvplus' ? ['playready', 'widevine'].includes(source.drm) && source.format.toLowerCase() === 'hls' : provider === 'dsnp' ? source.drm === 'widevine' && source.format.toLowerCase() === 'hls' : provider === 'crunchyroll' ? source.drm === 'widevine' && source.format.toLowerCase() === 'dash' : ['hamivideo', 'friday'].includes(provider) && source.drm === 'widevine' && source.format.toLowerCase() === 'dash'
    if (!supported || !source.contentKeys.length) {
      requireClearDownload(source)
    }
  }
  return sources
}
export function requireClearDownload(source: ManifestSource): void {
  if (source.live) throw new Error('直播录制尚未接入；不会启动无限下载')
  if (!source.clear) throw new Error('DRM_CLIENT_UNAVAILABLE：网关当前返回许可证而非可直接使用的内容密钥；尚未接入此授权媒体处理，不会按明文下载，也不会请求设备私钥')
}
export function providerLink(text: string): { provider: 'mewatch' | 'hamivideo' | 'friday' | 'linetv' | 'appletvplus' | 'dsnp'; url: string } | undefined {
  const dsnp = text.match(/https:\/\/(?:www\.|apps\.)?disneyplus\.com\/[^ <>]*?(entity-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  if (dsnp) return { provider: 'dsnp', url: dsnp[1]!.toLowerCase() }
  if (/^umc\.cmc\.[a-z0-9]+$/.test(text.trim())) return {provider:'appletvplus',url:text.trim()}
  const found = text.match(new RegExp('https://[^ <>]+', 'g')) || []
  for (const value of found) { try { const u = new URL(value.trim()); if (u.username || u.password) continue; if (u.hostname === 'tv.apple.com' && !u.port && /\/(show|movie|episode)\//.test(u.pathname)) return {provider:'appletvplus',url:u.href}; if (u.hostname === 'hamivideo.hinet.net') return { provider: 'hamivideo', url: u.href }; if (u.hostname === 'mewatch.sg' || u.hostname === 'www.mewatch.sg') return { provider: 'mewatch', url: u.href }; if (u.hostname === 'video.friday.tw') return { provider: 'friday', url: u.href }; if (u.hostname === 'linetv.tw' || u.hostname === 'www.linetv.tw') return { provider: 'linetv', url: u.href } } catch {} }
  return undefined
}
