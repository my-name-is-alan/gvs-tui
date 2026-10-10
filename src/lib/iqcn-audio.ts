import { appendFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import type { Audio } from '../types.ts'
import type { GwClient } from './client.ts'
import { asString, isObj } from './util.ts'
import { orderedDownload } from './ordered-download.ts'
import { runLog } from './runlog.ts'
import { selectAudioTracks } from './audio-selection.ts'

const LIMIT = 32 << 20
export const iqcnLanguage = (id: number): string => id === 1 ? 'zho' : 'und'

function audioChoiceID(row: Record<string, unknown>): string {
  const base = `iqcn:${Number(row.language_id)}:${Number(row.ct)}:${Number(row.bid)}:${asString(row.cf).toLowerCase()}`
  // Keep existing queued task IDs valid. Real content/channel variants remain
  // separate; the delivery format (ff) and episode-specific AID are not quality.
  const type = Number(row.aat) || 0, channels = Number(row.amt) || 0
  return type || channels ? `${base}:${type}:${channels}` : base
}

function audioSourcePriority(row: Record<string, unknown>): number {
  const format = asString(row.ff).toLowerCase()
  // The local-audio-v1 dispatcher accepts AMP4, not DASH .m4s objects.
  // Prefer only within the same language/codec/quality/channel choice.
  const embedded = Number(row.ct) === 1 && row.has_independent_files !== true
  return (embedded ? 1000 : 0) + (format === (embedded ? 'dash' : 'amp4') ? 300 : 20)
    + (row.has_independent_files === true ? 100 : 0) + (row.selected === true ? 1 : 0)
}

export function iqcnAudios(data: Record<string, unknown>): Audio[] {
  const groups = new Map<string, { row: Record<string, unknown>; selected: boolean }>()
  for (const row of Array.isArray(data.audios) ? data.audios.filter(isObj) : []) {
    if (!asString(row.aid)) continue
    const id = audioChoiceID(row), group = groups.get(id)
    if (!group) groups.set(id, { row, selected: row.selected === true })
    else {
      group.selected ||= row.selected === true
      if (audioSourcePriority(row) > audioSourcePriority(group.row)) group.row = row
    }
  }
  const choices = [...groups.entries()]
  const preferred = choices.find(([, group]) => group.selected)?.[0] ?? choices.find(([, group]) => group.row.has_independent_files === true)?.[0] ?? choices[0]?.[0]
  return choices.map(([id, { row }]) => {
    const codec = asString(row.cf).toUpperCase()
    const name = asString(row.name) || `语言 ${Number(row.language_id)}`
    const quality = Number(row.ct) === 5 ? '高码率' : Number(row.ct) === 1 ? '标准 · 随视频' : ''
    return { id, vid: asString(row.aid), label: [name, codec, quality].filter(Boolean).join(' · '), lang: name,
      codec, isDefault: id === preferred, selected: true }
  })
}

export function selectIQCNAudios(data: Record<string, unknown>, requested?: ReadonlyArray<{ id: string; isDefault?: boolean }>): Audio[] {
  const available = iqcnAudios(data)
  if (!requested?.length) return selectAudioTracks(available, available.filter(audio => audio.selected).map(audio => audio.id))
  const selected = new Map<string, Audio>()
  for (const wanted of requested) {
    let matches = available.filter(audio => audio.id === wanted.id)
    // Old tasks lack channel/type discriminators. Bind only if unambiguous.
    if (!matches.length && wanted.id.split(':').length === 5) matches = available.filter(audio => audio.id.startsWith(wanted.id + ':'))
    if (matches.length > 1) throw new Error('当前集有多个不同版本的所选音轨，请刷新音轨列表后重新选择。')
    const match = matches[0]
    if (!match?.vid) throw new Error('当前集暂不提供所选音轨，请返回音轨列表选择其他音轨。')
    const previous = selected.get(match.id)
    selected.set(match.id, { ...match, selected: true, isDefault: !!wanted.isDefault || !!previous?.isDefault })
  }
  const result = [...selected.values()]
  return selectAudioTracks(result, result.map(audio => audio.id), result.find(audio => audio.isDefault)?.id)
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>
const sourceCode = (value: unknown): string => {
  const code = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  return /^[A-Za-z0-9_.-]{1,24}$/.test(code) ? code : ''
}
class AudioFetchFailure extends Error {
  constructor(message: string, readonly httpStatus = 0, readonly sourceCode = '') { super(message) }
}
/** Read only a bounded error object and retain its code, never the signed address or response text. */
async function responseCode(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (reader) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > 4096) return ''
      chunks.push(Buffer.from(part.value))
    }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    return sourceCode(body.code ?? body.e)
  } catch { return '' }
  finally { await reader?.cancel().catch(() => {}); reader?.releaseLock() }
}
async function boundedFetch(url: string, fetcher: Fetcher, signal?: AbortSignal): Promise<Buffer> {
  const timeout = AbortSignal.timeout(60000)
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const res = await fetcher(url, { signal: active, redirect: 'manual' })
    if (res.status !== 200) throw new AudioFetchFailure(`音轨 HTTP ${res.status}`, res.status, await responseCode(res))
    if (!res.body) throw new AudioFetchFailure('音轨对象为空', res.status)
    reader = res.body.getReader()
    const chunks: Buffer[] = []
    let size = 0
    while (true) {
      active.throwIfAborted()
      const item = await reader.read()
      if (item.done) break
      size += item.value.length
      if (size > LIMIT) throw new AudioFetchFailure('音轨对象超过大小限制')
      chunks.push(Buffer.from(item.value))
    }
    if (!size) throw new AudioFetchFailure('音轨对象为空')
    return Buffer.concat(chunks)
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof AudioFetchFailure) throw error
    throw new AudioFetchFailure(timeout.aborted ? '爱奇艺音轨直连超时' : '爱奇艺音轨直连下载失败')
  } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock() }
}

export type IQCNAudioPlan = { planId: string; audioId: string; info: { language: string; title: string }; embedded: boolean; parts: URL[]; codec?: string }

export async function prepareIQCNAudio(cli: GwClient, planId: string, audioId: string, signal?: AbortSignal): Promise<IQCNAudioPlan> {
  signal?.throwIfAborted()
  const result = await cli.invoke('iqcn', 'audio', { planId, audioId }, {}, { timeoutMs: 150000 })
  signal?.throwIfAborted()
  if (result.transport !== 'local-audio-v1' || result.audioId !== audioId) throw new Error('网关未返回所选音轨，请同步更新网关和 App')
  const info = { language: iqcnLanguage(Number(result.language_id)), title: [asString(result.name), asString(result.codec).toUpperCase()].filter(Boolean).join(' · ') || '独立音轨' }
  if (result.embedded === true) return { planId, audioId, info, embedded: true, parts: [], codec: asString(result.codec) }
  if (!Array.isArray(result.parts) || !result.parts.length) throw new Error('所选独立音轨没有文件')
  const parts = result.parts.map((value, index) => {
    if (!isObj(value) || value.index !== index) throw new Error('音轨分段顺序无效')
    const url = new URL(asString(value.dispatch))
    if (url.protocol !== 'https:' || url.hostname !== 'data.video.ptqy.gitv.tv' || url.port || url.username || url.password || url.hash || !url.pathname.startsWith('/videos/v0/')) throw new Error('音轨调度地址无效')
    if (!url.pathname.toLowerCase().endsWith('.amp4')) throw new Error('所选独立音轨未返回可下载的 AMP4 文件，请刷新音轨列表或更新网关')
    return url
  })
  return { planId, audioId, info, embedded: false, parts, codec: asString(result.codec) }
}

export async function downloadIQCNAudio(cli: GwClient, planId: string, audioId: string, destination: string, threads: number, signal?: AbortSignal, fetcher: Fetcher = fetch, extractEmbedded?: () => Promise<void>, prepared?: IQCNAudioPlan): Promise<{ language: string; title: string }> {
  signal?.throwIfAborted()
  const plan = prepared ?? await prepareIQCNAudio(cli, planId, audioId, signal)
  if (plan.planId !== planId || plan.audioId !== audioId) throw new Error('音轨已变更，请刷新后重试。')
  const { info, parts } = plan
  if (plan.embedded) {
    if (!extractEmbedded) throw new Error('所选标准音轨需要从视频提取')
    await extractEmbedded()
    return info
  }
  writeFileSync(destination, '', { mode: 0o600 })
  try {
    await orderedDownload({ sizes: parts.map(() => LIMIT), budget: LIMIT * Math.min(8, Math.max(1, threads)), threads, signal,
      pull: async (index, abort) => {
        const dispatch = parts[index]!
        let last: unknown
        let stage = 'dispatch'
        for (let attempt = 0; attempt < 2; attempt++) {
          abort.throwIfAborted()
          try {
            stage = 'dispatch'
            const body = await boundedFetch(dispatch.href, fetcher, abort)
            if (body.length > 65536) throw new Error('音轨调度响应过大')
            const data = JSON.parse(body.toString())
            if (String(data.e) !== '0') throw new AudioFetchFailure('音轨调度失败', 200, sourceCode(data.e ?? data.code))
            const url = new URL(asString(data.l))
            if (url.protocol !== 'https:' || !url.hostname.endsWith('.ptqy.gitv.tv') || url.username || url.password || url.port || url.hash || url.pathname !== dispatch.pathname) throw new Error('音轨调度返回了其他文件')
            stage = 'cdn'
            const raw = await boundedFetch(url.href, fetcher, abort)
            stage = 'decompress'
            const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw, { maxOutputLength: LIMIT }) : raw
            if (!bytes.length) throw new Error('音轨对象为空')
            return bytes
          } catch (error) {
            abort.throwIfAborted()
            last = error
            const detail = error instanceof AudioFetchFailure ? error : undefined
            const codec = /^[A-Za-z0-9_.-]{1,24}$/.test(asString(plan.codec)) ? asString(plan.codec) : '-'
            runLog(`iqcn_audio_part_failed codec=${codec} index=${index} stage=${stage} attempt=${attempt + 1}/2 http=${detail?.httpStatus || '-'} source_code=${detail?.sourceCode || '-'}`)
          }
        }
        const message = last instanceof Error ? last.message : ''
        const safe = /^音轨 HTTP \d{3}$/.test(message) || ['爱奇艺音轨直连超时', '爱奇艺音轨直连下载失败', '音轨对象超过大小限制', '音轨对象为空', '音轨调度失败', '音轨调度返回了其他文件', '音轨调度响应过大'].includes(message) ? message : `${stage} 失败`
        throw new Error(`所选音轨分段下载失败（第 ${index + 1}/${parts.length} 段，${safe}）`)
      },
      write: bytes => { appendFileSync(destination, bytes) },
    })
    return info
  } catch (error) { try { unlinkSync(destination) } catch {} throw error }
}
