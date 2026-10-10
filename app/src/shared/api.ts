import type { TencentDiagnostic } from '../../../src/lib/diagnostic-types'
import type { ActualVersion, CompletedMedia } from '../../../src/lib/actual-version'
export type { TencentDiagnostic } from '../../../src/lib/diagnostic-types'
import { PROVIDER_IDS, PROVIDER_LABELS } from '../../../src/lib/providers'
// 主进程 ↔ 界面之间的契约。只放可序列化的纯数据。

export const PROVIDERS = PROVIDER_IDS
export type Provider = (typeof PROVIDERS)[number]

export const PROVIDER_NAME = PROVIDER_LABELS
export { supportsTmdb } from '../../../src/lib/providers'

export type { SessionCommand, ProviderSessionView } from '../../../src/lib/provider-session'
import type { SessionCommand, ProviderSessionView } from '../../../src/lib/provider-session'

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
  desktopProxy: string
  keyMasked: string
  hasKey: boolean
  outDir: string
  /** 临时目录：下载分片、解密、封装的中间文件。空 = 自动（放在下载目录所在盘的 .gvs-tmp，完成后直接改名，不跨盘复制） */
  tmpDir: string
  releaseGroup: string
  includeEpisodeTitle: boolean
  tmdbKey: string
  tmdbLang: string
  threads: number
  tencentObservations: boolean
  hamiClient: 'tv' | 'web'
  tencentCookie: string
  douyinCookie: string
  iqCookie: string
  iqProfile: string
  hongguoNfo: boolean
  huangguoNfo: boolean
  hongguoFmt: string
  huangguoFmt: string
}

export type SettingsPatch = Partial<Omit<SettingsView, 'keyMasked' | 'hasKey'>> & { key?: string }

export type AppState = {
  accountScope?: string
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
  /** target=search 时网关给的搜索词（缺省用标题） */
  query?: string
  /** 单视频（id 是 vid 而非节目 id），按 provider 走 detailFromLink */
  video?: boolean
  /** Explicit movie/TV metadata from search/browse, retained when detail lacks it. */
  mediaKind?: 'movie' | 'show'
}

export type DetailHint = { title?: string; poster?: string; mediaKind?: 'movie' | 'show' }

/** channels：栏目里嵌的子频道（红果剧场的「真人剧」「漫剧」…），界面当成栏目标签 */
export type BrowseResult = { cards: Card[]; channels: Section[]; more: boolean; next: string; notice: string }

export type SearchGroup = { provider: Provider; cards: Card[]; error: string }
export type SearchResult = { query: string; groups: SearchGroup[]; ms: number }

/** 粘贴链接直接打开的目标 */
export type LinkTarget =
  | { kind: 'youku'; vid: string }
  | { kind: 'tencent'; cid: string; vid: string; url: string }
  | { kind: 'mewatch' | 'hamivideo' | 'iq' | 'iqcn'; url: string }
  | { kind: 'none' }

export type EpisodeView = {
  tencentPlayParams?: import('../../../src/lib/tencent-edition-types').TencentPlayParams
  season?: number
  vid: string
  title: string
  number: number
  group: string
  collection?: string
  duration: number
  languages: Array<{ vid: string; lang: string; langcode?: string }>
}

export type DetailView = {
  focusVid?: string
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

export type TmdbHit = { id: number; name: string; title: string; year: number; overview: string; kind: 'movie' | 'show' }
export type { TmdbSeason, TmdbSeasonList } from '../../../src/lib/tmdb-types'
import type { TmdbSeasonList } from '../../../src/lib/tmdb-types'

export type EnqueueRequest = {
  token: number
  detail: Pick<DetailView, 'provider' | 'id' | 'title' | 'year' | 'kind' | 'poster'>
  episodes: EpisodeView[]
  quality: number
  audioIds: string[]
  /** 默认播放的已选音轨；省略时按 DTS、杜比 / 全景声、AAC 顺序自动选择。 */
  defaultAudioId?: string
  tmdb: TmdbHit | null
  /** Explicit season from the matched TMDB show's list; episode IDs/numbers stay unchanged. */
  tmdbSeason?: number
}

export type JobView = {
  id: number
  groupId: string
  groupTitle: string
  provider: Provider
  poster: string
  label: string
  quality: string
  actualVersion?: ActualVersion
  completedMedia?: CompletedMedia
  status: string
  pct: number
  log: string
  err: string
  note: string
  state: 'queued' | 'running' | 'paused' | 'done' | 'failed'
  output: string
  /** 入队 / 结束时间（毫秒时间戳，结束前为 0） */
  createdAt: number
  finishedAt: number
  /** 正在切换暂停/继续，按钮先禁用 */
  busy?: boolean
}

export type NamingPreview = { folder: string; file: string; note?: string }

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
  tencentDiagnostics(jobID?: number): Promise<TencentDiagnostic[]>
  providerSession(command: SessionCommand): Promise<ProviderSessionView>
  state(): Promise<AppState>
  setup(host: string, key: string, desktopProxy?: string): Promise<AppState>
  saveSettings(patch: SettingsPatch): Promise<AppState>
  catalog(provider: Provider): Promise<Section[]>
  browse(provider: Provider, section: Section, cursor?: string): Promise<BrowseResult>
  parseLink(text: string): Promise<LinkTarget>
  searchTargets(): Promise<Provider[]>
  searchProvider(provider: Provider, query: string): Promise<SearchGroup>
  /** hint：卡片上已有的标题/海报，详情接口没给时兜底 */
  detail(provider: Provider, id: string, hint?: DetailHint): Promise<DetailView>
  detailFromLink(link: LinkTarget, hint?: DetailHint): Promise<DetailView>
  probe(provider: Provider, episodes: EpisodeView[]): Promise<ProbeResult>
  namingPreview(req: EnqueueRequest): Promise<NamingPreview>
  tmdbSearch(title: string, tv: boolean): Promise<TmdbHit[]>
  tmdbSeasons(id: number): Promise<TmdbSeasonList>
  enqueue(req: EnqueueRequest): Promise<number>
  jobs(): Promise<JobView[]>
  retryJob(id: number): Promise<void>
  /** 暂停：停掉进程、保留已下载的部分；排队中的直接挂起 */
  pauseJob(id: number): Promise<void>
  /** 继续：重新排队，能续传的从断点接着下 */
  resumeJob(id: number): Promise<void>
  /** 从列表删除（运行中先停止）；deleteFiles 同时删掉已下载的成品与中间文件 */
  removeJob(id: number, deleteFiles?: boolean): Promise<void>
  pauseAll(): Promise<void>
  resumeAll(): Promise<void>
  clearFinished(): Promise<void>
  /** 缓存占用（字节）：posters 海报缓存；temp 临时目录里没有任务在用的残留 */
  cacheInfo(): Promise<{ posters: number; temp: number }>
  /** 清掉海报缓存与没有任务在用的临时残留 */
  clearCache(): Promise<void>
  openPath(path: string): Promise<void>
  showItem(path: string): Promise<void>
  /** 选文件夹；start 为对话框初始位置（缺省下载目录） */
  chooseDir(start?: string): Promise<string>
  youkuQrStart(): Promise<QRStart>
  iqcnQrStart(): Promise<QRStart>
  iqcnQrPoll(): Promise<QRPoll>
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
