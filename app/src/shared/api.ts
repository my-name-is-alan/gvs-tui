import type { TencentDiagnostic } from '../../../src/lib/diagnostic-types'
import type { DRMStatus, DRMSystem, PlatformMetaResponse } from '../../../src/lib/drm-types'
export type { DRMFileStatus, DRMStatus, DRMSystem, PlatformMeta, PlatformMethod, PlatformMetaResponse } from '../../../src/lib/drm-types'
import type { ActualVersion, CompletedMedia } from '../../../src/lib/actual-version'
export type { TencentDiagnostic } from '../../../src/lib/diagnostic-types'
import { PROVIDER_IDS, PROVIDER_LABELS } from '../../../src/lib/providers'
import type { UiPrefs } from './ui-prefs'
import type { SubscribeRequest, Subscription, SubscriptionPatch, SubsView } from './subscription'
import type { CalendarDay } from './calendar'
import type { AccountsView } from './accounts'
import type { QualityHint } from './quality-badges'
export type { AccountsView, AccountSlot, AccountBook, AccountStatus } from './accounts'
export type { QualityHint, QualityBadge } from './quality-badges'
export type { SubscribeRequest, Subscription, SubscriptionPatch, SubsView, CheckWindow, SubState } from './subscription'
export type { CalendarDay, CalendarItem } from './calendar'
export type { UiPrefs, QualityCap } from './ui-prefs'
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
  hamiClient: 'tv' | 'web'
  tencentCookie: string
  douyinCookie: string
  iqCookie: string
  iqProfile: string
  iqCdn?: 'auto' | 'akamai' | 'bscloud' | 'zenlayer'
  hongguoNfo: boolean
  huangguoNfo: boolean
  hongguoFmt: string
  huangguoFmt: string
  /** Desktop UI preferences (persisted as desktopUi in tui.json). */
  ui: UiPrefs
}

export type SettingsPatch = Partial<Omit<SettingsView, 'keyMasked' | 'hasKey' | 'ui'>> & { key?: string; ui?: Partial<UiPrefs>; iqCookieSource?: 'auto' | 'domestic' | 'international' }

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

export type Section = { id: string; title: string; mode: string; available: boolean; reason?: string; sourceTerminal?: 'mobile' | 'tv'; country?: string }

export type Card = {
  provider: Provider
  /** 咪咕的作品来源；服务端平台权限仍统一使用 migu。 */
  sourceTerminal?: 'mobile' | 'tv'
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
  | { kind: 'mewatch' | 'hamivideo' | 'friday' | 'linetv' | 'iq' | 'iqcn' | 'mgtv' | 'bilibili' | 'migu' | 'appletvplus' | 'dsnp'; url: string }
  | { kind: 'none' }

export type EpisodeView = {
  tencentPlayParams?: import('../../../src/lib/tencent-edition-types').TencentPlayParams
  season?: number
  vid: string
  title: string
  number: number
  group: string
  collection?: string
  /** Explicit movie edition for file names (Disney+ IMAX); overrides the title-derived one. */
  edition?: string
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
  /** Apple TV audio description track: shown as a tag and never preselected. */
  audioDescription?: boolean
}

export type SubtitleView = { id: string; label: string; lang: string; forced: boolean; sdh: boolean; selected: boolean; isDefault: boolean }

export type QualityView = {
  index: number
  label: string
  title: string
  stream: string
  width: number
  height: number
  size: number
  duration?: number
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
  /** Separately downloadable subtitles (Disney+); absent = subtitles follow the video. */
  subtitles?: SubtitleView[]
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
  /** Selected subtitle ids when the probe returned subtitles. */
  subtitleIds?: string[]
  /** 用户手动指定的默认音轨；省略时自动选择，实际 10 声道 DTS:X 优先让位给 DDP 5.1。 */
  defaultAudioId?: string
  tmdb: TmdbHit | null
  /** Explicit season from the matched TMDB show's list; episode IDs/numbers stay unchanged. */
  tmdbSeason?: number
  /** 多账号：用哪个账号下载（空 = 平台默认账号） */
  accountId?: string
}

export type JobView = {
  id: number
  groupId: string
  groupTitle: string
  provider: Provider
  /** 平台视频 ID：下载状态匹配用；旧任务从持久化的 task.vid 补回。 */
  vid?: string
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
  /** 开始 / 完成钩子的运行记录 */
  hooks?: HookRun[]
  /** 完成后计算的 ed2k 链接 */
  ed2k?: { state: 'running' | 'done' | 'failed'; pct: number; link: string; message?: string }
  /** 对应的下载历史记录 id */
  historyId?: number
}

export type HookEvent = 'start' | 'complete'
export type HookRun = { event: HookEvent; command: string; startedAt: number; finishedAt: number; exitCode: number | null; state: 'running' | 'ok' | 'failed' | 'timeout'; log: string; message: string }
export type HookSettings = {
  start: { notify: boolean; command: string }
  complete: { notify: boolean; command: string }
  /** 命令超时（秒） */
  timeoutSec: number
  /** 完成后自动计算 ed2k */
  ed2k: boolean
}

/** 下载历史（SQLite）：本地文件删掉后仍算已下载 */
export type HistoryEntry = {
  id: number
  jobKey: string
  provider: Provider
  showId: string
  showTitle: string
  vid: string
  season: number
  episode: number
  label: string
  title: string
  quality: string
  audio: string
  size: number
  filePath: string
  ed2k: string
  ed2kLink: string
  completedAt: number
}
export type HistoryQuery = { text?: string; provider?: string; showId?: string; limit?: number; offset?: number }

export type NamingPreview = { folder: string; file: string; note?: string }

export type QRImage = { title: string; image: string }
export type QRStart = { images: QRImage[]; hint: string }
export type QRPoll = { done: boolean; message: string; tone: Tone }

/**
 * Crunchyroll 浏览器 SSO 的结果：refresh_token 已写进本机配置，不回传令牌本体。
 * 字段不能叫 message/msg/hint/reason/summary —— userFacing() 会把它们当错误文案改写。
 */
export type CrLoginResult = { saved: boolean; country?: string; scope?: string; note: string }

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
  /** Crunchyroll 一键登录：开授权窗 → 截获 crunchyroll://auth 回跳 → 网关换令牌 → 存本机 */
  crunchyrollSsoLogin(): Promise<CrLoginResult>
  state(): Promise<AppState>
  setup(host: string, key: string, desktopProxy?: string): Promise<AppState>
  saveSettings(patch: SettingsPatch): Promise<AppState>
  catalog(provider: Provider, country?: string): Promise<Section[]>
  browse(provider: Provider, section: Section, cursor?: string): Promise<BrowseResult>
  parseLink(text: string): Promise<LinkTarget>
  searchTargets(): Promise<Provider[]>
  searchProvider(provider: Provider, query: string): Promise<SearchGroup>
  /** hint：卡片上已有的标题/海报，详情接口没给时兜底 */
  detail(provider: Provider, id: string, hint?: DetailHint): Promise<DetailView>
  detailFromLink(link: LinkTarget, hint?: DetailHint): Promise<DetailView>
  /** accountId：用指定账号探测（空 = 默认）；会员/登录错误时自动换号重试 */
  probe(provider: Provider, episodes: EpisodeView[], accountId?: string): Promise<ProbeResult>
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
  /** 本 Key 的设备文件状态（不含文件内容） */
  deleteDRMOne(system: DRMSystem, id: string): Promise<DRMStatus>
  drmStatus(): Promise<DRMStatus>
  /** 网关下发的平台账号说明；旧网关返回 null */
  platformMeta(): Promise<PlatformMetaResponse | null>
  /** 选文件并上传设备文件；取消返回 null */
  uploadDRM(system: DRMSystem): Promise<DRMStatus | null>
  deleteDRM(system: DRMSystem): Promise<DRMStatus>
  youkuQrStart(): Promise<QRStart>
  iqcnQrStart(): Promise<QRStart>
  iqcnQrPoll(): Promise<QRPoll>
  bilibiliQrStart(): Promise<QRStart>
  bilibiliQrPoll(): Promise<QRPoll>
  youkuQrPoll(): Promise<QRPoll>
  youkuRenew(): Promise<string>
  tencentQrStart(): Promise<QRStart>
  tencentQrPoll(): Promise<QRPoll>
  tencentNativeSmsStart(phone: string, area?: string): Promise<{ sent: boolean; message: string }>
  tencentNativeSmsSubmit(code: string): Promise<{ done: boolean; message: string }>
  qrCancel(): Promise<void>
  updateState(): Promise<UpdateState>
  checkUpdate(): Promise<UpdateState>
  installUpdate(): Promise<void>

  // ---- 订阅 / 追剧日历
  subscriptions(): Promise<SubsView>
  subscribe(req: SubscribeRequest): Promise<Subscription>
  updateSubscription(id: string, patch: SubscriptionPatch): Promise<Subscription>
  unsubscribe(id: string): Promise<void>
  /** 立即检查（省略 id = 全部未暂停的订阅） */
  checkSubscriptions(id?: string): Promise<void>
  setSubscriptionsPaused(paused: boolean): Promise<SubsView>
  setSubscriptionInterval(minutes: number): Promise<SubsView>
  /** 清掉「有更新」角标（省略 id = 全部） */
  markSubscriptionsSeen(id?: string): Promise<void>
  /** 平台排播（目前只有芒果 TV；其它平台由订阅推算） */
  calendar(): Promise<{ days: CalendarDay[]; error: string; fetchedAt: number }>

  // ---- 多账号
  accounts(): Promise<AccountsView>
  /** cookie 为空 = 扫码槽位（返回 needsLogin，界面接着走原有扫码流程） */
  addAccount(provider: Provider, name: string, cookie?: string): Promise<{ id: string; needsLogin: boolean }>
  renameAccount(id: string, name: string): Promise<void>
  removeAccount(id: string): Promise<void>
  setDefaultAccount(id: string): Promise<void>
  activateAccount(id: string): Promise<{ needsLogin: boolean }>
  updateAccountCookie(id: string, cookie: string): Promise<void>

  // ---- 下载历史 / 钩子 / ed2k
  history(q?: HistoryQuery): Promise<{ items: HistoryEntry[]; total: number }>
  historyForShow(provider: Provider, showId: string, episodeVids?: string[]): Promise<HistoryEntry[]>
  /** provider:showId → 已下载集数 */
  historyShowCounts(): Promise<Record<string, number>>
  removeHistory(id: number): Promise<void>
  /** 计算 ed2k（后台线程）；jobId 有值时进度显示在任务上 */
  computeEd2k(historyId: number, jobId?: number): Promise<string>
  hookSettings(): Promise<HookSettings>
  saveHookSettings(s: HookSettings): Promise<HookSettings>

  // ---- 搜索结果画质（懒加载探测，限流 + 缓存）
  qualityHint(provider: Provider, id: string): Promise<QualityHint | null>
}

export type GvsEvents = {
  state: AppState
  jobs: JobView[]
  toast: { message: string; tone: Tone }
  update: UpdateState
  subs: SubsView
  accounts: AccountsView
  /** 托盘菜单 / 通知点击要求界面跳到某页 */
  navigate: { view: string; subId?: string }
}

export interface GvsBridge {
  call<K extends keyof GvsApi>(method: K, ...args: Parameters<GvsApi[K]>): ReturnType<GvsApi[K]>
  on<K extends keyof GvsEvents>(event: K, cb: (payload: GvsEvents[K]) => void): () => void
}
