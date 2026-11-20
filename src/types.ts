import type { TmdbSeason } from './lib/tmdb-types'
import type { TencentPlayParams } from './lib/tencent-edition-types'
export type { TencentPlayParams } from './lib/tencent-edition-types'
import type { CompletedMedia } from './lib/actual-version'

export type Job = { id: number; title: string; status: string; pct: number; log: string; err: string; note?: string; phase?: string; completedMedia?: CompletedMedia; /** 平台视频 ID（腾讯下载/播放事件上报用） */ vid?: string; /** 平台标识（腾讯下载/播放事件上报用） */ provider?: string; /** 媒体总时长秒（腾讯播放事件 position 计算用） */ duration?: number }
export type Row = {
  title: string
  id: string
  sub: string
  rank?: number
  target?: { type: string; id?: string; query?: string; sectionId?: string; reason?: string }
  /** One-line blurb from the platform (e.g. `玄幻脑洞·全151集`). */
  desc?: string
  score?: string
  tags?: string[]
  mediaKind?: 'movie' | 'show'
}
export type Episode = {
  /** Stable edition request metadata from the gateway; never account secrets. */
  tencentPlayParams?: TencentPlayParams
  season?: number
  title: string
  vid: string
  number: number
  selected: boolean
  /** Length in seconds, when the platform reports it. */
  duration?: number
  /** Platform grouping, e.g. 正片 / 预告. */
  group?: string
  /** Official Tencent collection, preserved in selection and download paths. */
  collection?: string
  /** Explicit movie edition for file names (Disney+ 'IMAX' / '' for 原版); overrides the title-derived one. */
  edition?: string
  /** Other dvd.audiolang vids (国语/英语) to probe with this title. */
  languages?: Array<{ vid: string; lang: string; langcode?: string }>
}
export type TMDBHit = { id: number; name: string; title: string; year: number; overview?: string; kind: 'movie' | 'show' }
/** Tencent rendition identity; separate from the release-group suffix in file names. */
export type TencentQualitySelection = { formatId?: string; persona?: string; captionProbe?: string; group?: 'main' | 'encode' | 'source'; width?: number; height?: number; fps?: number; hdr?: string }
/** Domestic video IDs belong to one episode; retain stable attributes for batch matching. */
export type IQCNQualitySelection = { sourceTvid: string; codecCode?: number; dynamicRangeCode?: number }
export type Quality = {
  id: string
  label: string
  title: string
  size: number
  duration?: number
  width: number
  height: number
  codec: string
  drm: string
  tier?: number
  audios?: Audio[]
  /** soft | hard — 腾讯 TV caption */
  caption?: string
  /** Requested Tencent subtitle mode; does not confirm the delivered video's subtitles. */
  captionProbe?: 'soft' | 'hard'
  /** 同一份目录里同时存在 soft/hard 两种探测档时才有展示意义（否则默认 soft 会误导成全表软字幕）。 */
  captionProbeMixed?: boolean
  /** hdr | hdr10 | sdr — 腾讯 fi 动态范围（MAX+ / HDR10 / 臻彩 MAX·SDR） */
  hdr?: string
  fps?: number
  /** play defn / format name (maxplus, fhd, source…) */
  stream?: string
  /** Numeric platform format id (e.g. 322095), when known. */
  formatId?: string
  fname?: string
  group?: 'main' | 'encode' | 'source'
  /** Raw gateway persona (e.g. default_软 / h264_软 / 2741527771455_硬). */
  persona?: string
  /** Short encode label derived from persona (默认 / H264 / HEVC·A …). */
  encodeTag?: string
  iqcnQuality?: IQCNQualitySelection
}
/** Selectable audio track (only some platforms expose more than one). */
/** A separately downloadable subtitle rendition (Disney+ HLS); id = the rendition playlist file. */
export type Subtitle = { id: string; label: string; lang: string; forced: boolean; sdh: boolean; selected: boolean; isDefault: boolean }
export type Audio = { id: string; label: string; lang: string; codec: string; isDefault: boolean; selected: boolean; embedded?: boolean; vid?: string; url?: string; /** Apple TV: the track describes the video (audio description) and must not be preselected. */ audioDescription?: boolean }
export type Detail = {
  title: string
  desc: string
  category: string
  tags: string[]
  score: string
  episodes: number
  /** Total runtime in seconds, when known. */
  duration: number
  /** True when the platform marks the title VIP. */
  vip: boolean
  drm: string
  kind: 'movie' | 'show'
  year: number
}

export type StatusKind = 'info' | 'ok' | 'warn' | 'err'

/** 会员状态的来源：接口（网页 Cookie）/ 扫码时的快照 / 未知。 */
export type VipSource = 'api' | 'login' | 'none'

/** Per-title playback response; its isVip flag never certifies current account product membership. */
export type VipProbe = {
  canPlay: boolean
  isVip: boolean
  hasTrial: boolean
  /** 服务端给的下载许可（`download_status`），有些集是 `svip_ahead_allowed`。 */
  download: string
  note: string
}

/** Which column the quality screen is driving. */
export type OptionTab = 'quality' | 'audio' | 'subtitle'

export type Snapshot = {
  scene: string
  workspace?: import('./lib/discovery').DiscoveryView
  confirmation?: { title: string; episodes: string; quality: string; audio: string; directory: string; name: string; note?: string; kind?: 'movie' | 'show' | 'short'; year?: number }
  contentOffset?: number
  detailExpanded?: boolean
  settingsExpanded?: boolean
  jobDetailLines?: string[]
  logOffset?: number
  simulated?: boolean
  host: string
  status: string
  /** How to color `status` — the runtime classifies it at the call site. */
  statusKind: StatusKind
  /** A gateway call is in flight; the shell shows a spinner instead of looking frozen. */
  busy: boolean
  tunnelOk: boolean
  tunnelError?: string
  /** Which tunnel protocol the gateway accepted: WebSocket, or the legacy upgrade. */
  tunnelTransport?: 'ws' | 'legacy'
  /** 网关侧的优酷登录态摘要（cred info）。 */
  ykLogin?: { ok: boolean; summary: string; refreshable: boolean }
  /**
   * 账号状态。**只有 `needsScan` 为真才提示重新扫码**——
   * 会员那几个 mtop 接口报 SESSION_EXPIRED 只是「查不到会员」，不是掉登录。
   */
  ykAccount?: {
    membership?: import('./lib/youku-membership.ts').YoukuMembership
    loginUnknown?: boolean
    loggedIn: boolean
    needsScan: boolean
    nick: string
    uid: string
    method: string
    vipSource: VipSource
    isVip: boolean
    vipUntil: string
    riskLevel: string
    summary: string
  }
  /** 最近一次 `play` 的权益探测结果。 */
  vipProbe?: VipProbe
  cursor: number
  providerIndex: number
  qualityIndex: number
  audioIndex: number
  subtitleIndex?: number
  optionTab: OptionTab
  providers?: string[]
  homeItems?: string[]
  rows?: Row[]
  /** 列表还有下一页（网关 hasMore），光标到底会自动续。 */
  listMore?: boolean
  episodeGroups?: string[]
  episodeGroup?: string
  episodes?: Episode[]
  qualities?: Quality[]
  audios?: Audio[]
  /** Apple TV / Disney+ subtitle renditions; empty when the platform has none. */
  subtitles?: Subtitle[]
  tmdbHits?: TMDBHit[]
  tmdbState?: 'idle' | 'loading' | 'ready' | 'error'
  tmdbError?: string
  tmdbSeasonPicker?: { title: string; seasons: TmdbSeason[]; state: 'loading' | 'ready' | 'error'; error: string; warning?: string }
  canSelectTmdbSeason?: boolean
  jobs?: Job[]
  settings?: { label: string; value: string }[]
  detail?: Detail
  /** Scene heading for the browser: the title of whatever is open. */
  detailTitle?: string
  /** Provider of the open title (detail/quality), not discovery workspace. */
  detailProvider?: string
  pendingCount?: number
  /** Episode numbers queued for this quality page, in selection order. */
  pendingEpisodes?: number[]
  /** Probing the stream list failed and the next Enter downloads with defaults. */
  probeFailed: boolean
  query?: string
  hostInput?: string
  hostFocused: boolean
  keyFocused: boolean
  keyConfigured: boolean
  editField?: string
  editValue?: string
  qrHint?: string
  qrAscii?: string
  qrPngPaths?: string[]
}

export type Scene =
  | 'setup' | 'home' | 'search' | 'results' | 'detail'
  | 'quality' | 'tmdb' | 'jobs' | 'settings' | 'qr' | 'edit' | 'workspace' | 'filters' | 'confirm' | 'help' | 'job-detail'
