import { readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

export type IQSubtitleTags = { language: string; title: string; ai?: boolean }
export type IQSubtitleFile = IQSubtitleTags & { path: string }
export type ChineseScript = 'simplified' | 'traditional'

/** A generic Chinese language tag cannot distinguish simplified from traditional. */
export function iqSubtitleScript(sub: IQSubtitleTags): ChineseScript | undefined {
  const language = sub.language.trim().toLowerCase().replace(/_/g, '-')
  const title = sub.title.normalize('NFKC').toLowerCase()
  if (/繁[体體]|traditional/.test(title) || /(?:^|-)hant(?:-|$)/.test(language)) return 'traditional'
  if (/(?:简|簡)[体體]|simplified/.test(title) || language === 'chs' ||
    /^(?:zh|zho|chi|cmn)-(?:hans(?:-|$)|cn$|sg$|chs$)/.test(language)) return 'simplified'
  if (language === 'cht' || /^(?:zh|zho|chi|cmn)-(?:tw|hk|mo|cht)$/.test(language)) return 'traditional'
}

export function isIQSubtitleAI(sub: IQSubtitleTags): boolean {
  return sub.ai === true || /\bai\b|ai(?:字幕|翻[译譯]|生成)|(?:机器|機器|自动|自動|人工智能)翻[译譯]/i.test(sub.title.normalize('NFKC'))
}

/** Only fall back to AI Chinese when neither normal Chinese script is available. */
export function selectIQSubtitles<T extends IQSubtitleTags>(subtitles: readonly T[]): T[] {
  const sourceChinese = subtitles.some(sub => iqSubtitleScript(sub) && !isIQSubtitleAI(sub))
  return subtitles.filter(sub => !isIQSubtitleAI(sub) || !sourceChinese && !!iqSubtitleScript(sub))
}

function preferredIQSubtitleIndex(subtitles: readonly IQSubtitleTags[], script: ChineseScript): number {
  const candidates = subtitles.map((sub, index) => ({ ...sub, index })).filter(sub => iqSubtitleScript(sub) === script)
  return (candidates.find(sub => !isIQSubtitleAI(sub)) || candidates[0])?.index ?? -1
}

export function defaultIQSubtitleIndex(subtitles: readonly IQSubtitleTags[]): number {
  return preferredIQSubtitleIndex(subtitles, 'simplified')
}

/** Keep simplified first, traditional second and all remaining tracks in source order. */
export function orderedIQSubtitles<T extends IQSubtitleTags>(subtitles: readonly T[]): T[] {
  const first = new Set([preferredIQSubtitleIndex(subtitles, 'simplified'),
    preferredIQSubtitleIndex(subtitles, 'traditional')].filter(index => index >= 0))
  return [...first].map(index => subtitles[index]!).concat(subtitles.filter((_, index) => !first.has(index)))
}

const converters = new Map<ChineseScript, Promise<(text: string) => string>>()
async function converter(script: ChineseScript): Promise<(text: string) => string> {
  if (!converters.has(script)) converters.set(script, import('opencc-js').then(({ Converter }) =>
    Converter(script === 'simplified' ? { from: 't', to: 'cn' } : { from: 'cn', to: 't' })))
  return converters.get(script)!
}

/** Convert cue text only: IDs, timestamps, WebVTT metadata, markup and line endings stay intact. */
export async function convertIQSubtitleText(text: string, script: ChineseScript): Promise<string> {
  const convert = await converter(script)
  const timestamp = '(?:\\d+:)?\\d{2}:\\d{2}[,.]\\d{3}'
  const timing = new RegExp(`^\\s*${timestamp}\\s+-->\\s*${timestamp}(?:\\s.*)?$`)
  const markup = /(<[^>]*>|\{\\[^}]*\}|&(?:#\d+|#x[\da-f]+|[a-z][\w]*);)/gi
  let inCue = false, metadata = false, cues = 0, hasText = false
  const output = text.split(/(\r\n|\n|\r)/).map(line => {
    if (/^[\r\n]+$/.test(line)) return line
    if (!line.trim()) { inCue = false; metadata = false; return line }
    if (!inCue && /^(?:\uFEFF)?(?:WEBVTT(?:\s|$)|NOTE(?:\s|$)|STYLE\s*$|REGION\s*$)/.test(line)) metadata = true
    if (metadata) return line
    if (timing.test(line)) { inCue = true; cues++; return line }
    if (!inCue) return line
    hasText = true
    return line.split(markup).map((part, index) => index % 2 ? part : convert(part)).join('')
  }).join('')
  if (!cues || !hasText) throw new Error('字幕没有可转换的有效时间轴和正文')
  return output
}

/** Complete a Chinese pair locally; generated tracks retain AI provenance when it is the only source. */
export async function prepareIQSubtitles(
  subtitles: readonly IQSubtitleFile[], work: string, signal?: AbortSignal,
  convert = convertIQSubtitleText,
): Promise<{ subtitles: IQSubtitleFile[]; note?: string }> {
  signal?.throwIfAborted()
  const selected = selectIQSubtitles(subtitles).map(sub => isIQSubtitleAI(sub) && !isIQSubtitleAI({ ...sub, ai: false })
    ? { ...sub, title: `${sub.title} (AI)` } : sub)
  const simplified = preferredIQSubtitleIndex(selected, 'simplified')
  const traditional = preferredIQSubtitleIndex(selected, 'traditional')
  if ((simplified < 0) === (traditional < 0)) return { subtitles: orderedIQSubtitles(selected) }
  const script: ChineseScript = simplified < 0 ? 'simplified' : 'traditional'
  const source = selected[simplified < 0 ? traditional : simplified]!
  const label = script === 'simplified' ? '简体中文' : '繁体中文'
  try {
    const extension = extname(source.path).toLowerCase()
    if (!['.srt', '.vtt'].includes(extension)) throw new Error('不支持的字幕格式')
    const bytes = readFileSync(source.path)
    if (bytes.length > 16 * 1024 * 1024) throw new Error('字幕过大')
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    const result = await convert(text, script)
    signal?.throwIfAborted()
    const path = join(work, `iq-sub-opencc-${script}${extension}`)
    writeFileSync(path, result, { mode: 0o600 })
    const ai = isIQSubtitleAI(source)
    selected.push({ path, language: 'zho', title: ai ? `${label} (AI)` : label, ai })
    return { subtitles: orderedIQSubtitles(selected) }
  } catch {
    signal?.throwIfAborted()
    return { subtitles: orderedIQSubtitles(selected), note: `${label} OpenCC 转换失败，已保留可用原字幕` }
  }
}
