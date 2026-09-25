import { reactive } from 'vue'
import type {
  AppState,
  DetailView,
  EpisodeView,
  GvsApi,
  JobView,
  ProbeResult,
  Provider,
  SearchResult,
  UpdateState,
  Tone,
} from '@shared/api'

export type View = 'discover' | 'search' | 'detail' | 'quality' | 'downloads' | 'settings'

// 参数可能是 Vue 响应式代理，IPC 的结构化克隆不认；统一转成纯数据再发。
export const gvs = <K extends keyof GvsApi>(method: K, ...args: Parameters<GvsApi[K]>): ReturnType<GvsApi[K]> =>
  window.gvs.call(method, ...(JSON.parse(JSON.stringify(args)) as Parameters<GvsApi[K]>))

type Toast = { id: number; message: string; tone: Tone }

export const store = reactive({
  state: null as AppState | null,
  jobs: [] as JobView[],
  view: 'discover' as View,
  history: [] as View[],

  query: '',
  search: null as SearchResult | null,
  searching: false,
  searchError: '',
  /** 还在搜的平台 */
  searchPending: [] as Provider[],

  detail: null as DetailView | null,
  detailLoading: false,
  detailError: '',
  /** 选中的集 vid */
  picked: [] as string[],

  probe: null as ProbeResult | null,
  probeEpisodes: [] as EpisodeView[],
  probing: false,
  probeError: '',

  qr: null as null | 'youku' | 'tencent',
  update: null as UpdateState | null,
  toasts: [] as Toast[],
})

let toastId = 0
export function toast(message: string, tone: Tone = 'muted'): void {
  const id = ++toastId
  store.toasts.push({ id, message, tone })
  setTimeout(() => {
    const i = store.toasts.findIndex((t) => t.id === id)
    if (i >= 0) store.toasts.splice(i, 1)
  }, tone === 'err' ? 7000 : 3500)
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function go(view: View): void {
  if (store.view === view) return
  store.history.push(store.view)
  if (store.history.length > 30) store.history.shift()
  store.view = view
}

export function back(fallback: View = 'discover'): void {
  store.view = store.history.pop() ?? fallback
}

export async function runSearch(raw: string): Promise<void> {
  const q = raw.trim()
  if (!q) return
  store.query = q
  // 粘贴的播放页链接：直接进详情
  const link = await gvs('parseLink', q)
  if (link.kind !== 'none') {
    await openDetailWith(() => gvs('detailFromLink', link))
    return
  }
  go('search')
  const gen = ++searchGen
  store.searching = true
  store.searchError = ''
  store.search = { query: q, groups: [], ms: 0 }
  store.searchPending = []
  const t0 = Date.now()
  try {
    const targets = await gvs('searchTargets')
    if (gen !== searchGen) return
    store.searchPending = [...targets]
    await Promise.all(
      targets.map(async (p) => {
        const g = await gvs('searchProvider', p, q)
        if (gen !== searchGen || !store.search) return
        store.search.groups.push(g)
        store.search.ms = Date.now() - t0
        store.searchPending = store.searchPending.filter((x) => x !== p)
      }),
    )
  } catch (e) {
    if (gen === searchGen) store.searchError = errText(e)
  } finally {
    if (gen === searchGen) store.searching = false
  }
}

let searchGen = 0

async function openDetailWith(load: () => Promise<DetailView>): Promise<void> {
  go('detail')
  store.detail = null
  store.detailError = ''
  store.detailLoading = true
  store.picked = []
  try {
    const d = await load()
    store.detail = d
    // 只有一集/一个版本时直接选上；多集不预选，让用户自己挑
    if (d.episodes.length === 1) store.picked = [d.episodes[0]!.vid]
  } catch (e) {
    store.detailError = errText(e)
  } finally {
    store.detailLoading = false
  }
}

export function openDetail(provider: Provider, id: string): Promise<void> {
  return openDetailWith(() => gvs('detail', provider, id))
}

export async function openQuality(): Promise<void> {
  const d = store.detail
  if (!d) return
  const eps = d.episodes.filter((e) => store.picked.includes(e.vid))
  if (!eps.length) return
  store.probeEpisodes = eps
  store.probe = null
  store.probeError = ''
  store.probing = true
  go('quality')
  try {
    store.probe = await gvs('probe', d.provider, eps)
  } catch (e) {
    store.probeError = errText(e)
  } finally {
    store.probing = false
  }
}

export function initStore(): void {
  window.gvs.on('state', (s) => (store.state = s))
  window.gvs.on('jobs', (j) => (store.jobs = j))
  window.gvs.on('toast', (t) => toast(t.message, t.tone))
  window.gvs.on('update', (u) => (store.update = u))
  void gvs('updateState').then((u) => (store.update = u))
  void gvs('state').then((s) => (store.state = s))
  void gvs('jobs').then((j) => (store.jobs = j))
}

export function hasProvider(p: Provider): boolean {
  return !!store.state?.providers.includes(p)
}

export function human(bytes: number): string {
  if (!bytes || bytes <= 0) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`
}
