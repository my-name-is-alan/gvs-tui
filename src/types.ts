export type Job = { id: number; title: string; status: string; pct: number; log: string; err: string }
export type Row = { title: string; id: string; sub: string }
export type Episode = { title: string; vid: string; number: number; selected: boolean }
export type Quality = { id: string; label: string; title: string; size: number; width: number; height: number; codec: string; drm: string }
export type TMDBHit = { id: number; name: string; title: string; year: number; overview?: string }

export type Snapshot = {
  scene: string
  host: string
  status: string
  tunnelOk: boolean
  tunnelError?: string
  cursor: number
  providerIndex: number
  qualityIndex: number
  providers?: string[]
  homeItems?: string[]
  rows?: Row[]
  episodes?: Episode[]
  qualities?: Quality[]
  tmdbHits?: TMDBHit[]
  jobs?: Job[]
  settings?: { label: string; value: string }[]
  detailTitle?: string
  pendingCount?: number
  query?: string
  hostInput?: string
  hostFocused: boolean
  keyFocused: boolean
  keyConfigured: boolean
  editField?: string
  editValue?: string
  qrAscii?: string
  footer?: string
}

export type Scene =
  | 'setup' | 'home' | 'search' | 'results' | 'detail'
  | 'quality' | 'tmdb' | 'jobs' | 'settings' | 'qr' | 'edit'
