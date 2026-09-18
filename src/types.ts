export type Job = { id: number; title: string; status: string; pct: number; log: string; err: string }
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
}
export type Episode = {
  title: string
  vid: string
  number: number
  selected: boolean
  /** Length in seconds, when the platform reports it. */
  duration?: number
  /** Platform grouping, e.g. 正片 / 预告. */
  group?: string
}
export type TMDBHit = { id: number; name: string; title: string; year: number; overview?: string }
export type Quality = { id: string; label: string; title: string; size: number; width: number; height: number; codec: string; drm: string; tier?: number; audios?: Audio[] }
/** Selectable audio track (only some platforms expose more than one). */
export type Audio = { id: string; label: string; lang: string; codec: string; isDefault: boolean; selected: boolean; embedded?: boolean }
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

/** `play` 出来的真实取流结果——判断「这个账号现在到底能不能看 VIP」比会员接口可信。 */
export type VipProbe = {
  canPlay: boolean
  isVip: boolean
  hasTrial: boolean
  /** 服务端给的下载许可（`download_status`），有些集是 `svip_ahead_allowed`。 */
  download: string
  note: string
}

/** Which column the quality screen is driving. */
export type OptionTab = 'quality' | 'audio'

export type Snapshot = {
  scene: string
  workspace?: import('./lib/discovery').DiscoveryView
  confirmation?: { title: string; episodes: string; quality: string; audio: string; directory: string; name: string }
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
  optionTab: OptionTab
  providers?: string[]
  homeItems?: string[]
  rows?: Row[]
  /** 列表还有下一页（网关 hasMore），光标到底会自动续。 */
  listMore?: boolean
  episodes?: Episode[]
  qualities?: Quality[]
  audios?: Audio[]
  tmdbHits?: TMDBHit[]
  jobs?: Job[]
  settings?: { label: string; value: string }[]
  detail?: Detail
  /** Scene heading for the browser: the title of whatever is open. */
  detailTitle?: string
  pendingCount?: number
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
