export type Job = { id: number; title: string; status: string; pct: number; log: string; err: string }
export type Row = {
  title: string
  id: string
  sub: string
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
export type Quality = { id: string; label: string; title: string; size: number; width: number; height: number; codec: string; drm: string }
/** Selectable audio track (only some platforms expose more than one). */
export type Audio = { id: string; label: string; lang: string; codec: string; isDefault: boolean }
/** Title-level metadata shown on the detail screen. */
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
}

export type StatusKind = 'info' | 'ok' | 'warn' | 'err'

/** Which column the quality screen is driving. */
export type OptionTab = 'quality' | 'audio'

export type Snapshot = {
  scene: string
  host: string
  status: string
  /** How to color `status` — the runtime classifies it at the call site. */
  statusKind: StatusKind
  /** A gateway call is in flight; the shell shows a spinner instead of looking frozen. */
  busy: boolean
  tunnelOk: boolean
  tunnelError?: string
  cursor: number
  providerIndex: number
  qualityIndex: number
  audioIndex: number
  optionTab: OptionTab
  providers?: string[]
  homeItems?: string[]
  rows?: Row[]
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
  qrAscii?: string
}

export type Scene =
  | 'setup' | 'home' | 'search' | 'results' | 'detail'
  | 'quality' | 'tmdb' | 'jobs' | 'settings' | 'qr' | 'edit'
