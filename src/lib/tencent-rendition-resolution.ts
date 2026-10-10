import type { TencentQualitySelection } from '../types.ts'
import { qualitiesFromTencentFormats } from './quality.ts'
import { selectedTencentQuality, tencentCaption, tencentChoiceSelection, tencentDownloadSelection, tencentPersonaKey, type TencentQualityChoice } from './tencent-quality-selection.ts'
import { asString, isObj } from './util.ts'

function codecKey(value: string): string {
  const key = value.trim().toLowerCase().replace(/[ ._-]/g, '')
  if (['hevc', 'h265', 'hvc1', 'hev1'].includes(key)) return 'hevc'
  if (['avc', 'h264', 'avc1'].includes(key)) return 'avc'
  return ['—', '-', 'unknown'].includes(key) ? '' : key
}

/** Format IDs belong to an episode. Rebind only a unique, fully described
 * rendition with the same tier, encoding persona, subtitle mode and specs.
 * Never retain the catalog's URLs, cookies or keys in the resolved selector. */
export function equivalentTencentRendition(choice: TencentQualityChoice & { codec?: string }, formats: unknown): TencentQualitySelection | undefined {
  const selected = tencentChoiceSelection(choice)
  const input = tencentDownloadSelection(choice)
  const codec = codecKey(choice.codec || '')
  const hdr = selected.hdr?.trim().toLowerCase()
  if (!Array.isArray(formats) || !selected.formatId || !selected.persona || !input.caption ||
    !selected.width || !selected.height || !selected.fps || !hdr || !codec) return undefined
  const rows = formats.filter(isObj).flatMap(raw => {
    const q = qualitiesFromTencentFormats([raw])[0]
    // Catalog display rounds fps to an integer; identity comparison must retain 59.94.
    const fps = Number(raw.vfps || raw.fps)
    if (q && Number.isFinite(fps) && fps > 0) q.fps = fps
    return q ? [{ raw, q }] : []
  })
  const equivalent = ({ raw, q }: typeof rows[number]): boolean => {
    const actualCodec = [q.codec, asString(raw.vencoding), asString(raw.codec)].map(codecKey).filter(Boolean)
    return !!q.formatId && q.stream?.toLowerCase() === input.stream.toLowerCase()
      && tencentPersonaKey(q.persona || '').toLowerCase() === tencentPersonaKey(selected.persona!).toLowerCase()
      && (!selected.group || q.group === selected.group)
      && tencentCaption(q.captionProbe || q.caption || '') === input.caption
      && (!q.caption || tencentCaption(q.caption) === input.caption)
      && Math.abs(Math.max(q.width, q.height) - Math.max(selected.width!, selected.height!)) <= 16
      && Math.abs(Math.min(q.width, q.height) - Math.min(selected.width!, selected.height!)) <= 16
      && !!q.fps && Math.abs(q.fps - selected.fps!) < 0.1
      && q.hdr?.toLowerCase() === hdr && actualCodec.includes(codec)
  }
  const candidates = rows.filter(equivalent)
  const identity = ({ q }: typeof rows[number]) => JSON.stringify([q.formatId, q.persona, q.captionProbe, q.group])
  const unique = [...new Map(candidates.map(row => [identity(row), row])).values()]
  if (unique.length !== 1 || unique[0]!.q.formatId === selected.formatId) return undefined
  // Conflicting duplicate catalog rows are not evidence of equivalence.
  if (rows.some(row => identity(row) === identity(unique[0]!) && !equivalent(row))) return undefined
  return selectedTencentQuality(unique[0]!.q)
}
