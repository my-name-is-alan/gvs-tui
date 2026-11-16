/**
 * 搜索结果的「最佳画质」徽标。两种来源：
 * - meta：平台搜索结果里本来就有的文字（标题 / 角标 / 简介里的 4K、杜比视界、HDR…），零成本
 * - probe：懒加载探测（详情 + 第一集画质），主进程限流 + 超时 + 缓存
 */
export type QualityBadge = '4K' | '1080P' | 'HDR' | 'DV' | 'DOLBY' | 'ATMOS' | 'DTS' | '60FPS' | 'IMAX'
export type QualityHint = { badges: QualityBadge[]; height: number; source: 'meta' | 'probe' | 'none'; at: number }

export const BADGE_LABEL: Record<QualityBadge, string> = { '4K': '4K', '1080P': '1080P', HDR: 'HDR', DV: '杜比视界', DOLBY: '杜比', ATMOS: '全景声', DTS: 'DTS', '60FPS': '60帧', IMAX: 'IMAX' }
const ORDER: QualityBadge[] = ['4K', '1080P', 'DV', 'HDR', 'IMAX', 'ATMOS', 'DOLBY', 'DTS', '60FPS']
const sort = (b: Iterable<QualityBadge>) => ORDER.filter((x) => new Set(b).has(x))

export function badgesFromText(...texts: Array<string | undefined>): QualityHint {
  const t = texts.filter(Boolean).join(' ')
  const out = new Set<QualityBadge>()
  let height = 0
  if (/4K|2160[Pp]?|超高清|UHD/i.test(t)) { out.add('4K'); height = 2160 }
  else if (/1080[Pp]|蓝光|全高清|FHD/i.test(t)) { out.add('1080P'); height = 1080 }
  if (/杜比视界|Dolby\s*Vision|\bDV\b|DoVi/i.test(t)) out.add('DV')
  if (/HDR(?:10)?|HDR Vivid|菁彩/i.test(t)) out.add('HDR')
  if (/全景声|Atmos/i.test(t)) out.add('ATMOS')
  else if (/杜比音效|杜比音频|Dolby\s*(?:Audio|Digital)|DD\+|E-?AC-?3|(?<!视界)杜比(?!视界)/i.test(t)) out.add('DOLBY')
  if (/\bDTS\b/i.test(t)) out.add('DTS')
  if (/60\s*(?:帧|fps)|高帧率/i.test(t)) out.add('60FPS')
  if (/IMAX/i.test(t)) out.add('IMAX')
  const badges = sort(out)
  return { badges, height, source: badges.length ? 'meta' : 'none', at: 0 }
}

type Q = { height: number; hdr: string; fps?: number; label?: string; codec?: string; audios?: Array<{ label: string; codec: string }> }

export function badgesFromQualities(qs: Q[], audios: Array<{ label: string; codec: string }> = [], now = Date.now()): QualityHint {
  const out = new Set<QualityBadge>()
  let height = 0
  for (const q of qs) {
    height = Math.max(height, q.height || 0)
    const hdr = `${q.hdr || ''} ${q.label || ''}`
    if (/dolby\s*vision|dolbyvision|dovi|\bdv\b|杜比视界/i.test(hdr)) out.add('DV')
    else if (q.hdr && !/^sdr$/i.test(q.hdr)) out.add('HDR')
    if ((q.fps ?? 0) >= 50) out.add('60FPS')
    if (/imax/i.test(q.label || '')) out.add('IMAX')
    for (const a of [...(q.audios ?? []), ...audios]) {
      const s = `${a.label} ${a.codec}`
      if (/atmos|全景声/i.test(s)) out.add('ATMOS')
      else if (/dolby|杜比|e-?ac-?3|ec-?3|ddp|ac-?3/i.test(s)) out.add('DOLBY')
      if (/dts/i.test(s)) out.add('DTS')
    }
  }
  if (height >= 2000) out.add('4K')
  else if (height >= 1000) out.add('1080P')
  if (out.has('ATMOS')) out.delete('DOLBY')
  return { badges: sort(out), height, source: 'probe', at: now }
}

/** 合并：取更强的一方（探测结果优先补全） */
export function mergeHints(a: QualityHint | null | undefined, b: QualityHint | null | undefined): QualityHint {
  if (!a) return b ?? { badges: [], height: 0, source: 'none', at: 0 }
  if (!b) return a
  return { badges: sort([...a.badges, ...b.badges]), height: Math.max(a.height, b.height), source: b.source === 'probe' || a.source === 'probe' ? 'probe' : a.source, at: Math.max(a.at, b.at) }
}

/** 排序用分数：分辨率为主，HDR/杜比加分 */
export function qualityScore(h: QualityHint | null | undefined): number {
  if (!h) return 0
  const res = h.height || (h.badges.includes('4K') ? 2160 : h.badges.includes('1080P') ? 1080 : 0)
  return res * 10 + (h.badges.includes('DV') ? 6 : h.badges.includes('HDR') ? 4 : 0) + (h.badges.includes('ATMOS') ? 3 : h.badges.includes('DOLBY') ? 2 : 0) + (h.badges.includes('60FPS') ? 1 : 0)
}

/** 有限并发 + 单项超时 + 结果缓存（含失败的负缓存）的探测队列。纯 TS，主进程用。 */
export class HintQueue<T> {
  private cache = new Map<string, { at: number; value: T | null }>()
  private inflight = new Map<string, Promise<T | null>>()
  private waiting: Array<() => void> = []
  private running = 0
  constructor(
    private readonly run: (key: string, signal: AbortSignal) => Promise<T>,
    private readonly opts: { concurrency: number; timeoutMs: number; ttlMs: number; failTtlMs: number; now?: () => number; max?: number },
  ) {}
  private now = () => (this.opts.now ?? Date.now)()
  peek(key: string): T | null | undefined {
    const c = this.cache.get(key)
    if (!c) return undefined
    if (this.now() - c.at > (c.value === null ? this.opts.failTtlMs : this.opts.ttlMs)) { this.cache.delete(key); return undefined }
    return c.value
  }
  get pending(): number { return this.running + this.waiting.length }
  get(key: string): Promise<T | null> {
    const hit = this.peek(key)
    if (hit !== undefined) return Promise.resolve(hit)
    const f = this.inflight.get(key)
    if (f) return f
    const p = this.slot().then(async () => {
      const ac = new AbortController()
      try {
        const timer = setTimeout(() => ac.abort(), this.opts.timeoutMs)
        const v = await this.run(key, ac.signal).finally(() => clearTimeout(timer))
        this.put(key, v)
        return v
      } catch {
        this.put(key, null)
        return null
      } finally {
        this.running--
        this.inflight.delete(key)
        this.waiting.shift()?.()
      }
    })
    this.inflight.set(key, p)
    return p
  }
  private put(key: string, value: T | null) {
    this.cache.set(key, { at: this.now(), value })
    const max = this.opts.max ?? 500
    while (this.cache.size > max) this.cache.delete(this.cache.keys().next().value!)
  }
  private slot(): Promise<void> {
    if (this.running < this.opts.concurrency) { this.running++; return Promise.resolve() }
    return new Promise((r) => this.waiting.push(() => { this.running++; r() }))
  }
}
