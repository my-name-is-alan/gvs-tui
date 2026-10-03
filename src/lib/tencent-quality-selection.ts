import type { Quality, TencentQualitySelection } from '../types.ts'

export function tencentCaption(value: string): string {
  const c = value.trim().toLowerCase()
  if (['soft', '软', '软字幕', 'srt'].includes(c)) return 'soft'
  if (['hard', '硬', '硬字幕', 'burn'].includes(c)) return 'hard'
  return c
}

export function tencentPersonaKey(value: string): string {
  return value.trim().replace(/_(?:软|硬|soft|hard)$/i, '')
}

/** Never persist expiring URLs, cookies or decryption keys with the rendition. */
export function selectedTencentQuality(q: Pick<Quality, 'id' | 'formatId' | 'persona' | 'group'>): TencentQualitySelection | undefined {
  const parts = q.id.split('|')
  const formatId = q.formatId || (parts.length >= 3 && parts[2] !== '0' ? parts[2] : '')
  const persona = q.persona || (parts.length >= 4 && !['main', 'encode', 'source'].includes(parts[3]!) ? parts[3] : '')
  const group = q.group
  if (!formatId && !persona && group !== 'source') return undefined
  return { ...(formatId ? { formatId } : {}), ...(persona ? { persona } : {}), ...(group ? { group } : {}) }
}

export type TencentQualityChoice = {
  quality?: string; stream?: string; caption?: string; group?: string
  formatId?: string; persona?: string; tencentQuality?: TencentQualitySelection
}

export function tencentChoiceSelection(q: TencentQualityChoice): TencentQualitySelection {
  const composite = (q.stream || q.quality || '').split('|')
  return q.tencentQuality ?? selectedTencentQuality({ id: composite.join('|'), formatId: q.formatId, persona: q.persona,
    group: ['main', 'encode', 'source'].includes(q.group || '') ? q.group as TencentQualitySelection['group'] : undefined }) ?? {}
}

/** Compatible play request: the deployed gateway may only accept defn/caption. */
export function tencentSelectedPlayInput(q: TencentQualityChoice): Record<string, string> {
  const parts = (q.stream || q.quality || 'fhd').trim().split('|')
  const out: Record<string, string> = { defn: parts[0]! }
  const cap = tencentCaption(q.caption || (parts.length > 1 ? parts[1]! : ''))
  if (cap === 'soft' || cap === 'hard') out.caption = cap
  return out
}

export function tencentDownloadSelection(q: TencentQualityChoice): { stream: string; caption?: string; formatId?: string } {
  const selection = tencentChoiceSelection(q)
  const input = tencentSelectedPlayInput(q)
  return { stream: input.defn, caption: input.caption, formatId: selection.formatId }
}
