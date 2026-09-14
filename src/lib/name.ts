import { join } from 'node:path'

export type MediaKind = 'show' | 'movie' | 'short'

export type Naming = {
  kind: MediaKind
  title: string
  nameDots: string
  year: number
  season: number
  episode: number
  height: number
  codec: string
  audio?: string
  dv?: boolean
  source: string
  group: string
  tmdbId: number
  container: string
}

export function sourceTag(provider: string): string {
  switch (provider) {
    case 'youku': return 'YK'
    case 'tencent': return 'TX'
    case 'hongguo': return 'HG'
    case 'douyin': return 'DY'
    default: return provider ? provider.slice(0, 3).toUpperCase() : 'WEB'
  }
}

export function dots(s: string): string {
  let out = ''
  let lastDot = true
  for (const r of s.trim()) {
    if (/[\p{L}\p{N}]/u.test(r)) {
      out += r
      lastDot = false
      continue
    }
    if (!lastDot) {
      out += '.'
      lastDot = true
    }
  }
  out = out.replace(/^\.+|\.+$/g, '')
  return out || 'Untitled'
}

export function sanitizePath(s: string): string {
  let out = ''
  for (const r of s.trim()) {
    if ('/\\:*?"<>|'.includes(r)) out += '_'
    else if (r.charCodeAt(0) >= 32) out += r
  }
  return out.trim()
}

export function folder(n: Naming, outDir: string): string {
  if (n.kind === 'short') return join(outDir, sanitizePath(n.title))
  let base = n.nameDots || dots(n.title)
  if (n.year > 0) base = `${base}.${n.year}`
  if (n.tmdbId > 0) base = `${base} {tmdb-${n.tmdbId}}`
  let dir = join(outDir, sanitizePath(base))
  if (n.kind === 'show' && n.season > 0) dir = join(dir, `Season ${String(n.season).padStart(2, '0')}`)
  return dir
}

export function filename(n: Naming): string {
  const parts: string[] = []
  if (n.kind === 'short') {
    parts.push(n.title.trim() || 'episode')
    if (n.season > 0 || n.episode > 0) {
      parts.push(`S${String(Math.max(n.season, 1)).padStart(2, '0')}E${String(Math.max(n.episode, 1)).padStart(2, '0')}`)
    }
  } else {
    parts.push(n.nameDots || dots(n.title))
    if (n.kind === 'show') {
      parts.push(`S${String(Math.max(n.season, 1)).padStart(2, '0')}E${String(Math.max(n.episode, 1)).padStart(2, '0')}`)
    }
    if (n.year > 0) parts.push(String(n.year))
  }
  if (n.height > 0) parts.push(`${n.height}p`)
  if (n.source) parts.push(n.source)
  parts.push('WEB-DL')
  if (n.codec) parts.push(n.codec)
  if (n.dv) parts.push('DV')
  if (n.audio) parts.push(n.audio)
  const ext = n.container || 'mkv'
  const stem = sanitizePath(parts.join('.'))
  const g = n.group.trim()
  return g ? `${stem}-${sanitizePath(g)}.${ext}` : `${stem}.${ext}`
}
