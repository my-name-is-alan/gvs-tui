import type { IQCNQualitySelection, Quality } from '../types.ts'
import type { GwClient } from './client.ts'
import type { DlTask } from './jobs.ts'
import { asString, isObj } from './util.ts'
import { iqcnEpisodeRendition } from './iqcn-rendition.ts'

export function iqcnSelection(quality: string): Record<string, string> {
  const parts = quality.split('|')
  if (![3, 4].includes(parts.length)) throw new Error('爱奇艺国内版画质选择无效')
  const [bid, br, fr, vid] = parts
  if (![bid, br, fr].every(value => value && /^[1-9]\d*$/.test(value))) throw new Error('爱奇艺国内版画质选择无效')
  if (parts.length === 4 && !/^[A-Za-z0-9]+$/.test(vid || '')) throw new Error('爱奇艺国内版视频标识无效')
  return { bid: bid!, br: br!, fr: fr!, ...(vid ? { vid } : {}) }
}

function code(value: unknown): number | undefined {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return undefined
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

export function iqcnRendition(raw: Record<string, unknown>, sourceTvid: string): IQCNQualitySelection {
  return { sourceTvid, codecCode: code(raw.codec_code), dynamicRangeCode: code(raw.dynamic_range_code) }
}

export function selectedIQCNQuality(q: Quality, sourceTvid: string): IQCNQualitySelection {
  return { ...q.iqcnQuality, sourceTvid: q.iqcnQuality?.sourceTvid || sourceTvid }
}

/** Old queues copied the probe episode's ID into the whole batch. This is only
 * a source hint: resolution below verifies that ID against the source catalog. */
export function restoreIQCNSourceHints(tasks: DlTask[]): boolean {
  const sources = new Map<string, string>()
  let changed = false
  for (const task of tasks) {
    if (task.provider !== 'iqcn' || typeof task.quality !== 'string' || !task.vid || task.quality.split('|').length !== 4) continue
    const key = JSON.stringify([task.series, task.quality])
    if (!sources.has(key)) sources.set(key, task.iqcnQuality?.sourceTvid || task.vid)
    if (!task.iqcnQuality) {
      task.iqcnQuality = { sourceTvid: sources.get(key)! }
      changed = true
    }
  }
  return changed
}

type Rendition = { selection: Record<string, string>; attributes: IQCNQualitySelection }
function renditions(data: Record<string, unknown>, tvid: string): Rendition[] {
  if (asString(data.tvid) && asString(data.tvid) !== tvid) throw new Error('爱奇艺国内版返回了其他集的画质信息')
  const rows = Array.isArray(data.formats) ? data.formats.filter(isObj) : []
  return rows.flatMap(raw => {
    const id = asString(raw.id) || [raw.bid, raw.br, raw.fr, ...(raw.vid ? [raw.vid] : [])].map(asString).join('|')
    try { return [{ selection: iqcnSelection(id), attributes: iqcnRendition(raw, tvid) }] }
    catch { return [] }
  })
}
function sameTier(a: Record<string, string>, b: Record<string, string>): boolean {
  return a.bid === b.bid && a.br === b.br && a.fr === b.fr
}
function matches(actual: IQCNQualitySelection, expected: IQCNQualitySelection): boolean {
  return (expected.codecCode === undefined || actual.codecCode === expected.codecCode)
    && (expected.dynamicRangeCode === undefined || actual.dynamicRangeCode === expected.dynamicRangeCode)
}

/** Rebind the episode-specific VID without changing bitrate, fps, codec or range. */
export async function resolveIQCNSelection(cli: GwClient, task: Pick<DlTask, 'vid' | 'quality' | 'iqcnQuality'> & Partial<Pick<DlTask, 'codec'>>, signal?: AbortSignal): Promise<Record<string, string>> {
  signal?.throwIfAborted()
  const requested = iqcnSelection(task.quality)
  // Old gateways accept only BID/BR/FR and do not expose rendition identities.
  if (!requested.vid) return requested
  const probe = async (tvid: string) => {
    const data = await cli.invoke('iqcn', 'probe', { tvid }, {}, { timeoutMs: 150000 })
    signal?.throwIfAborted()
    return { data, rows: renditions(data, tvid) }
  }
  const currentProbe = await probe(task.vid)
  const current = currentProbe.rows
  const exact = current.find(row => sameTier(row.selection, requested) && row.selection.vid === requested.vid)
  let expected = task.iqcnQuality
  if (exact && (!expected || matches(exact.attributes, expected))) return exact.selection
  if (!expected?.sourceTvid) {
    // Upstream tasks without persisted rendition attributes still bind the
    // current episode using its selected codec and one unambiguous candidate.
    if (task.codec) return iqcnEpisodeRendition(currentProbe.data, task.vid, requested, task.codec)
    throw new Error('爱奇艺国内版视频标识属于其他集，缺少原始画质依据，请重新选择画质')
  }
  if (expected.codecCode === undefined || expected.dynamicRangeCode === undefined) {
    const source = expected.sourceTvid === task.vid ? current : (await probe(expected.sourceTvid)).rows
    const original = source.find(row => sameTier(row.selection, requested) && row.selection.vid === requested.vid && matches(row.attributes, expected!))
    if (!original) throw new Error('爱奇艺国内版无法确认原始视频版本，请重新选择画质')
    expected = { ...original.attributes, ...expected,
      codecCode: expected.codecCode ?? original.attributes.codecCode,
      dynamicRangeCode: expected.dynamicRangeCode ?? original.attributes.dynamicRangeCode }
  }
  // Missing codec/range is not evidence of equivalence (e.g. DV vs HDR10).
  if (expected.codecCode === undefined || expected.dynamicRangeCode === undefined)
    throw new Error('爱奇艺国内版缺少编码或动态范围依据，请更新网关或重新选择画质')
  const candidates = current.filter(row => sameTier(row.selection, requested) && matches(row.attributes, expected!))
  const unique = [...new Map(candidates.filter(row => row.selection.vid).map(row => [row.selection.vid, row])).values()]
  if (!unique.length) throw new Error('当前集缺少所选码率、帧率、编码或动态范围版本，请重新选择可用画质')
  if (unique.length !== 1) throw new Error('当前集有多个相同规格的视频版本，无法确认对应地址，请单独选择本集画质')
  return unique[0]!.selection
}
