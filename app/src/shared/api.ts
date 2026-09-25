// 主进程 ↔ 界面之间的契约。只放可序列化的纯数据。

export const PROVIDERS = ['youku', 'tencent', 'hongguo', 'huangguo', 'douyin'] as const
export type Provider = (typeof PROVIDERS)[number]

export const PROVIDER_NAME: Record<string, string> = {
  youku: '优酷',
  tencent: '腾讯',
  hongguo: '红果',
  huangguo: '黄果',
  douyin: '抖音',
}

export type Tone = 'ok' | 'warn' | 'err' | 'muted'

export type AccountView = {
  provider: Provider
  /** 侧栏短标签：已登录 / 免登录 / 未设置 … */
  short: string
  /** 设置页一行摘要 */
  summary: string
  tone: Tone
}

export type SettingsView = {
  host: string
  keyMasked: string
  hasKey: boolean
  outDir: string
  releaseGroup: string
  tmdbKey: string
  tmdbLang: string
  threads: number
  tencentCookie: string
  douyinCookie: string
  hongguoNfo: boolean
  huangguoNfo: boolean
  hongguoFmt: string
  huangguoFmt: string
}

export type SettingsPatch = Partial<Omit<SettingsView, 'keyMasked' | 'hasKey'>> & { key?: string }

export type AppState = {
  configured: boolean
  connecting: boolean
  keyName: string
  keyError: string
  providers: Provider[]
  tunnel: { ok: boolean; err: string; enabled: boolean }
  accounts: AccountView[]
  settings: SettingsView
  tools: { name: string; ok: boolean; note: string }[]
  version: string
  platform: string
}

export type Section = { id: string; title: string; mode: string; available: boolean; reason?: string }

export type Card = {
  provider: Provider
  id: string
  title: string
  poster: string
  desc: string
  meta: string
  score: string
  rank?: number
  vip: boolean
  /** detail = 能直接打开详情；search = 只能按标题搜；unavailable = 预约等 */
  target: 'detail' | 'search' | 'unavailable'
  reason?: string
}

/** channels：栏目里嵌的子频道（红果剧场的「真人剧」「漫剧」…），界面当成栏目标签 */
export type BrowseResult = { cards: Card[]; channels: Section[]; more: boolean; next: string; notice: string }

export type SearchGroup = { provider: Provider; cards: Card[]; error: string }
export type SearchResult = { query: string; groups: SearchGroup[]; ms: number }

/** 粘贴链接直接打开的目标 */
export type LinkTarget =
  | { kind: 'youku'; vid: string }
  | { kind: 'tencent'; cid: string; vid: string; url: string }
  | { kind: 'none' }

export type EpisodeView = {
  vid: string
  title: string
  number: number
  group: string
  duration: number
  languages: Array<{ vid: string; lang: string; langcode?: string }>
}

export type DetailView = {
  provider: Provider
  id: string
  title: string
  poster: string
  desc: string
  category: string
  year: number
  tags: string[]
  score: string
  vip: boolean
  drm: string
  kind: 'movie' | 'show'
  episodeCount: number
  episodes: EpisodeView[]
  /** 电影多版本（国语/英语）时为 edition */
  pickNoun: '集' | '个版本'
}

export type AudioView = {
  id: string
  label: string
  lang: string
  codec: string
  isDefault: boolean
  selected: boolean
  embedded: boolean
}

export type QualityView = {
  index: number
  label: string
  title: string
  stream: string
  width: number
  height: number
  size: number
  codec: string
  drm: string
  hdr: string
  fps: number
  audios: AudioView[]
}

export type ProbeResult = {
  token: number
  qualities: QualityView[]
  audios: AudioView[]
  vip: { canPlay: boolean; isVip: boolean; hasTrial: boolean; note: string } | null
  warning: string
}

export type TmdbHit = { id: number; name: string; title: string; year: number; overview: string }

export type EnqueueRequest = {
  token: number
  detail: Pick<DetailView, 'provider' | 'id' | 'title' | 'year' | 'kind' | 'poster'>
  episodes: EpisodeView[]
  quality: number
  audioIds: string[]
  tmdb: TmdbHit | null
}

export type JobView = {
  id: number
  groupId: string
  groupTitle: string
  provider: Provider
  poster: string
  label: string
  quality: string
  status: string
  pct: number
  log: string
  err: string
  note: string
  state: 'queued' | 'running' | 'done' | 'failed'
  output: string
}

export type NamingPreview = { folder: string; file: string }

export type QRImage = { title: string; image: string }
export type QRStart = { images: QRImage[]; hint: string }
export type QRPoll = { done: boolean; message: string; tone: Tone }

/**
 * idle 未检查 · checking 检查中 · latest 已是最新 · available 有新版（mac/开发版只提示）
 * downloading 下载中 · ready 已下载待安装 · error 出错
 */
export type UpdateState = {
  status: 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error'
  version: string
  current: string
  percent: number
  message: string
  url: string
  /** 能否自动下载安装（Windows 安装版） */
  auto: boolean
}

/** 界面可调用的全部方法（preload 按名字转发到主进程）。 */
export interface GvsApi {
  state(): Promise<AppState>
  setup(host: string, key: string): Promise<AppState>
  saveSettings(patch: SettingsPatch): Promise<AppState>
  catalog(provider: Provider): Promise<Section[]>
  browse(provider: Provider, section: Section, cursor?: string): Promise<BrowseResult>
  parseLink(text: string): Promise<LinkTarget>
  searchTargets(): Promise<Provider[]>
  searchProvider(provider: Provider, query: string): Promise<SearchGroup>
  detail(provider: Provider, id: string): Promise<DetailView>
  detailFromLink(link: LinkTarget): Promise<DetailView>
  probe(provider: Provider, episodes: EpisodeView[]): Promise<ProbeResult>
  namingPreview(req: EnqueueRequest): Promise<NamingPreview>
  tmdbSearch(title: string, tv: boolean): Promise<TmdbHit[]>
  enqueue(req: EnqueueRequest): Promise<number>
  jobs(): Promise<JobView[]>
  retryJob(id: number): Promise<void>
  clearFinished(): Promise<void>
  openPath(path: string): Promise<void>
  showItem(path: string): Promise<void>
  chooseDir(): Promise<string>
  youkuQrStart(): Promise<QRStart>
  youkuQrPoll(): Promise<QRPoll>
  youkuRenew(): Promise<string>
  tencentQrStart(): Promise<QRStart>
  tencentQrPoll(): Promise<QRPoll>
  qrCancel(): Promise<void>
  updateState(): Promise<UpdateState>
  checkUpdate(): Promise<UpdateState>
  installUpdate(): Promise<void>
}

export type GvsEvents = {
  state: AppState
  jobs: JobView[]
  toast: { message: string; tone: Tone }
  update: UpdateState
}

export interface GvsBridge {
  call<K extends keyof GvsApi>(method: K, ...args: Parameters<GvsApi[K]>): ReturnType<GvsApi[K]>
  on<K extends keyof GvsEvents>(event: K, cb: (payload: GvsEvents[K]) => void): () => void
}
