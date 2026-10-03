import { reactive } from 'vue'
import { ipcArgs } from '@shared/ipc-args'
import type {
  AppState,
  Card,
  DetailView,
  DetailHint,
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
export type SettingsTab = 'download' | 'account' | 'gateway' | 'naming' | 'about'

// 参数可能是 Vue 响应式代理，IPC 的结构化克隆不认；统一转成纯数据再发。
export const gvs = <K extends keyof GvsApi>(method: K, ...args: Parameters<GvsApi[K]>): ReturnType<GvsApi[K]> =>
  window.gvs.call(method, ...ipcArgs(args))

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
  /** 卡片上已有的标题/海报：详情接口没给时兜底，骨架屏也能先显示 */
  detailHint: null as DetailHint | null,
  /** 选中的集 vid */
  picked: [] as string[],

  settingsTab: 'download' as SettingsTab,
  dlFilter: 'all' as 'all' | 'active' | 'paused' | 'failed' | 'done',

  probe: null as ProbeResult | null,
  probeEpisodes: [] as EpisodeView[],
  probing: false,
  probeError: '',

  qr: null as null | 'youku' | 'tencent',
  /** 打开着的确认框数量：Esc 返回时要避开 */
  dialogCount: 0,
  update: null as UpdateState | null,
  toasts: [] as Toast[],
})

/** 还有弹窗挡在前面（Esc 归弹窗管） */
export const modalOpen = () => store.qr !== null || store.dialogCount > 0

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

/** 侧栏高亮：详情/画质页归到进来的那一栏（发现或搜索） */
export function section(): View {
  if (store.view !== 'detail' && store.view !== 'quality') return store.view
  for (let i = store.history.length - 1; i >= 0; i--) {
    const v = store.history[i]
    if (v === 'discover' || v === 'search') return v
  }
  return 'search'
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

async function openDetailWith(load: () => Promise<DetailView>, hint?: DetailHint | null): Promise<void> {
  go('detail')
  store.detail = null
  store.detailError = ''
  store.detailLoading = true
  store.picked = []
  store.detailHint = hint ?? null
  try {
    const d = await load()
    store.detail = d
    // 提示里的海报/标题兜住接口没给的情况
    if (hint?.poster && !d.poster) d.poster = hint.poster
    // 只有一集/一个版本时直接选上；多集不预选，让用户自己挑
    if (d.focusVid && d.episodes.some(e => e.vid === d.focusVid)) store.picked = [d.focusVid]
    else if (d.episodes.length === 1) store.picked = [d.episodes[0]!.vid]
  } catch (e) {
    store.detailError = errText(e)
  } finally {
    store.detailLoading = false
  }
}

export function openDetail(provider: Provider, id: string, hint?: DetailHint): Promise<void> {
  return openDetailWith(() => gvs('detail', provider, id, hint), hint)
}

/** 优酷单视频：id 是 vid，走链接解析 */
export function openVideo(vid: string, hint?: DetailHint): Promise<void> {
  return openDetailWith(() => gvs('detailFromLink', { kind: 'youku', vid }, hint), hint)
}

/** 卡片统一入口：能开详情就开详情，只能搜就搜，预约类不动作 */
export function openCard(c: Card): void {
  if (c.target === 'unavailable') return
  const hint = { title: c.title, poster: c.poster, mediaKind: c.mediaKind }
  if (c.video) void openVideo(c.id, hint)
  else if (c.target === 'detail' && c.id) void openDetail(c.provider, c.id, hint)
  else void runSearch(c.query || c.title)
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

/** 相对时间：刚刚 / 3 分钟前 / 3 小时前 / 2 天前 */
export function ago(ms: number): string {
  if (!ms) return ''
  const d = Date.now() - ms
  if (d < 60e3) return '刚刚'
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} 小时前`
  return `${Math.floor(d / 86400e3)} 天前`
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
