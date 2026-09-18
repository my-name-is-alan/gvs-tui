import type { Row } from '../types'
export type Section = {
  id: string
  title: string
  mode: string
  contentType: string
  available: boolean
  paginated?: boolean
  reason?: string
  filters?: Array<{
    key: string
    title: string
    options: Array<{ value: string; label: string }>
  }>
}
export type DiscoveryView = {
  provider: string
  mode: string
  sections: Section[]
  sectionIndex: number
  focus: 'sections' | 'list'
  rows: Row[]
  cursor: number
  more: boolean
  loading: boolean
  error: string
  notice: string
  source: string
  category: string
  compatibility: boolean
  filters: Record<string, string>
}
type List = {
  rows: Row[]
  cursor: number
  more: boolean
  next: string
  source: string
  notice: string
  category: string
  at: number
}
export type Invoke = (
  provider: string,
  action: string,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const str = (v: unknown) =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
export function discoveryRows(
  provider: string,
  data: Record<string, unknown>,
): Row[] {
  const items = Array.isArray(data.items)
    ? data.items
    : Array.isArray(data.list)
      ? data.list
      : []
  const seen = new Set<string>()
  return items.flatMap((v) => {
    const i = obj(v),
      meta = obj(i.meta),
      title = str(i.title || i.name || meta.title),
      id = str(
        i.seriesId ||
          i.showId ||
          i.cid ||
          i.id ||
          meta.seriesId ||
          meta.showId ||
          meta.cid,
      )
    const kind = str(i.kind || meta.kind)
    if (!title || /advert|广告|trailer|预告/.test(kind)) return []
    const key = id && !id.includes('://') ? id : title
    if (seen.has(key)) return []
    seen.add(key)
    let target = obj(i.target || meta.target)
    if (!target.type)
      target =
        id && !id.includes('://')
          ? { type: 'detail', id }
          : { type: 'search', query: title }
    if (
      data.contentType === 'reservation' ||
      kind === 'reservation' ||
      kind === '预约'
    )
      target = { type: 'unavailable', reason: '预约内容尚不可下载' }
    return [
      {
        title,
        id,
        sub: provider,
        desc: str(i.subtitle || i.desc || meta.subtitle || meta.subTitle),
        score: str(i.score || meta.score),
        rank:
          data.contentType === 'rank' && Number(i.rank) > 0
            ? Number(i.rank)
            : undefined,
        target: target as Row['target'],
      },
    ]
  })
}
export function fallbackSections(provider: string): Section[] {
  const section = (
    id: string,
    title: string,
    mode: string,
    contentType: string,
    available = true,
    reason = '',
  ): Section => ({ id, title, mode, contentType, available, reason })
  if (provider === 'youku')
    return [
      section('legacy-recommend', '平台推荐', 'home', 'recommendation'),
      section(
        'legacy-rank',
        '榜单未接通',
        'rank',
        'rank',
        false,
        '旧网关没有独立榜单',
      ),
    ]
  if (provider === 'tencent')
    return [
      section(
        'legacy-home',
        '推荐暂不可用',
        'home',
        'recommendation',
        false,
        '旧网关会用热搜回退，不作为推荐展示',
      ),
      section('legacy-hot', '热搜榜', 'rank', 'rank'),
    ]
  return [
    section(
      'legacy-theatre',
      '剧场待升级',
      'home',
      'recommendation',
      false,
      '升级网关后可查看公开剧场',
    ),
    ...['recommend', 'hot', 'real', 'new', 'zhenguo', 'subscribe'].map(
      (s, i) => ({
        ...section(
          'legacy-' + s,
          ['推荐榜', '热播榜', '真人剧热播', '新剧榜', '臻果榜', '预约榜'][i],
          'rank',
          s === 'subscribe' ? 'reservation' : 'rank',
        ),
        paginated: true,
      }),
    ),
  ]
}
export class Discovery {
  view: DiscoveryView = {
    provider: 'youku',
    mode: 'home',
    sections: [],
    sectionIndex: 0,
    focus: 'list',
    rows: [],
    cursor: 0,
    more: false,
    loading: false,
    error: '',
    notice: '',
    source: '',
    category: '',
    compatibility: false,
    filters: {},
  }
  private catalogs = new Map<
    string,
    { sections: Section[]; at: number; compatibility: boolean }
  >()
  private lists = new Map<string, List>()
  private selections = new Map<
    string,
    { index: number; filters: Record<string, string> }
  >()
  private filterSelections = new Map<string, Record<string, string>>()
  private generation = 0
  private inFlight = new Map<string, number>()
  private activeKey = ''
  constructor(
    private invoke: Invoke,
    private emit: () => void,
    private now = () => Date.now(),
  ) {}
  get visibleSections() {
    return this.view.sections.filter((s) => s.mode === this.view.mode)
  }
  get section() {
    return this.visibleSections[this.view.sectionIndex]
  }
  private key() {
    return JSON.stringify([
      this.view.provider,
      this.view.mode,
      this.section?.id,
      Object.fromEntries(
        Object.entries(this.view.filters).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ),
    ])
  }
  private remember() {
    if (this.section)
      this.filterSelections.set(this.view.provider + '|' + this.section.id, {
        ...this.view.filters,
      })
    const l = this.lists.get(this.activeKey)
    if (l) l.cursor = this.view.cursor
    this.selections.set(this.view.provider + '|' + this.view.mode, {
      index: this.view.sectionIndex,
      filters: { ...this.view.filters },
    })
  }
  invalidate() {
    this.generation++
    this.view.loading = false
  }
  clear() {
    this.invalidate()
    this.catalogs.clear()
    this.lists.clear()
    this.selections.clear()
    this.filterSelections.clear()
    this.activeKey = ''
  }
  async open(provider: string, mode = 'home', refresh = false) {
    this.remember()
    const g = ++this.generation
    const saved = this.selections.get(provider + '|' + mode)
    Object.assign(this.view, {
      provider,
      mode,
      rows: [],
      more: false,
      error: '',
      notice: '',
      source: '',
      category: '',
      loading: true,
      sections: [],
      sectionIndex: saved?.index ?? 0,
      filters: { ...saved?.filters },
      focus: 'list',
    })
    this.emit()
    try {
      let catalog = this.catalogs.get(provider)
      if (!catalog || refresh || this.now() - catalog.at > 300000) {
        try {
          const data = await this.invoke(provider, 'browse_catalog', {})
          if (!Array.isArray(data.sections)) throw new Error('INVALID_CATALOG')
          catalog = {
            sections: data.sections as Section[],
            at: this.now(),
            compatibility: false,
          }
        } catch (e) {
          if (
            !/unknown.*action|action.*browse_catalog|INVALID_CATALOG|not supported|PROVIDER_NOT_FOUND|http 404/i.test(
              String(e),
            )
          )
            throw e
          catalog = {
            sections: fallbackSections(provider),
            at: this.now(),
            compatibility: true,
          }
        }
        if (g !== this.generation) return
        this.catalogs.set(provider, catalog)
      }
      if (g !== this.generation) return
      this.view.sections = catalog.sections
      this.view.compatibility = catalog.compatibility
      this.view.sectionIndex = Math.min(
        this.view.sectionIndex,
        Math.max(0, this.visibleSections.length - 1),
      )
      await this.load(false, refresh)
    } catch (e) {
      if (g === this.generation) {
        this.view.error = String(e instanceof Error ? e.message : e)
        this.view.loading = false
        this.emit()
      }
    }
  }
  async choose(index: number) {
    if (index === this.view.sectionIndex) return
    this.remember()
    this.generation++
    this.view.sectionIndex = index
    this.view.filters = {
      ...this.filterSelections.get(this.view.provider + '|' + this.section?.id),
    }
    await this.load(false, false)
  }
  async channel(id: string, title: string) {
    this.remember()
    if (!this.visibleSections.some((s) => s.id === id))
      this.view.sections = [
        ...this.view.sections,
        {
          id,
          title,
          mode: this.view.mode,
          contentType: 'recommendation',
          available: true,
        },
      ]
    this.view.sectionIndex = this.visibleSections.findIndex((s) => s.id === id)
    this.generation++
    await this.load(false, false)
  }
  async filter(key: string, value: string) {
    this.remember()
    this.generation++
    this.view.filters = { ...this.view.filters, [key]: value }
    await this.load(false, false)
  }
  async load(more = false, refresh = false) {
    const section = this.section
    if (!section) {
      Object.assign(this.view, {
        rows: [],
        loading: false,
        notice: '没有可用栏目',
      })
      this.emit()
      return
    }
    const key = this.key(),
      g = this.generation,
      prev = this.lists.get(key)
    if (more && (!prev?.more || !prev.next || this.inFlight.get(key) === g))
      return
    if (this.inFlight.get(key) === g) {
      return
    }
    this.activeKey = key
    if (!more && !refresh && prev && this.now() - prev.at < 300000) {
      this.restore(prev)
      this.emit()
      return
    }
    if (!section.available) {
      Object.assign(this.view, {
        rows: [],
        more: false,
        loading: false,
        error: '',
        notice: section.reason || '此栏目当前不可用',
        source: '',
        category: section.title,
        cursor: 0,
      })
      this.emit()
      return
    }
    this.inFlight.set(key, g)
    this.view.loading = true
    this.view.error = ''
    if (!more) {
      this.view.rows = []
      this.view.more = false
      this.view.cursor = 0
      this.view.notice = ''
    }
    this.emit()
    try {
      const input: Record<string, unknown> = {
        mode: section.mode,
        ...this.view.filters,
      }
      if (!this.view.compatibility) input.sectionId = section.id
      else if (this.view.provider === 'hongguo')
        input.sub = section.id.replace('legacy-', '')
      if (more) {
        input.cursor = prev!.next
        if (this.view.provider === 'hongguo') {
          input.offset = prev!.next
          input.seenIds = prev!.rows
            .map((r) => r.id)
            .filter(Boolean)
            .join(',')
        }
      }
      if (refresh) input.refresh = '1'
      const data = await this.invoke(this.view.provider, 'browse', input)
      if (g !== this.generation || key !== this.key()) return
      if (
        this.view.compatibility &&
        this.view.provider === 'youku' &&
        data.source &&
        data.source !== 'mtop-recommend'
      )
        throw new Error(
          '旧网关返回了其他内容源，无法确认为平台推荐，请升级网关',
        )
      const effective = {
        ...data,
        contentType: data.contentType || section.contentType,
      }
      const rows = discoveryRows(this.view.provider, effective),
        seen = new Set((more ? prev!.rows : []).map((r) => r.id || r.title)),
        fresh = rows.filter((r) => !seen.has(r.id || r.title))
      const next = str(data.nextCursor),
        hasMore =
          data.hasMore === true &&
          !!next &&
          (!more || next !== prev!.next) &&
          (!more || fresh.length > 0)
      const l: List = {
        rows: more ? [...prev!.rows, ...fresh] : rows,
        cursor: more ? Math.min(this.view.cursor, prev!.rows.length) : 0,
        next,
        more: hasMore,
        source: str(data.source),
        category: str(data.category) || section.title,
        notice:
          str(data.notice) ||
          (more && !fresh.length
            ? '没有新增内容，已停止分页'
            : more && next === prev!.next
              ? '游标未前进，已停止分页'
              : ''),
        at: this.now(),
      }
      this.lists.set(key, l)
      this.restore(l)
    } catch (e) {
      if (g === this.generation) {
        this.view.error = e instanceof Error ? e.message : String(e)
        this.view.loading = false
      }
    } finally {
      if (this.inFlight.get(key) === g) this.inFlight.delete(key)
      if (g === this.generation) {
        this.view.loading = false
        this.emit()
      }
    }
  }
  private restore(l: List) {
    Object.assign(this.view, {
      rows: l.rows,
      cursor: l.cursor,
      more: l.more,
      source: l.source,
      category: l.category,
      notice: l.notice,
      loading: false,
      error: '',
    })
  }
}
