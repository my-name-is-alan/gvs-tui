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
  /** 电影配音版本，如 英语版 / 国语版。 */
  edition?: string
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
    case 'huangguo': return 'HGO'
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
  if (n.source === 'HG' || n.source === 'HGO') {
    return join(outDir, sanitizePath(n.title), `season ${Math.max(n.season, 1)}`)
  }
  if (n.kind === 'short') return join(outDir, sanitizePath(n.title))
  let base = n.nameDots || dots(n.title)
  if (n.year > 0) base = `${base}.${n.year}`
  if (n.tmdbId > 0) base = `${base} {tmdb-${n.tmdbId}}`
  let dir = join(outDir, sanitizePath(base))
  if (n.kind === 'show' && n.season > 0) dir = join(dir, `Season ${String(n.season).padStart(2, '0')}`)
  return dir
}

/**
 * 真实像素 → 发行命名里的规范档位。片源常见 letterbox / 2:1 画幅，
 * 直接拿高度会写出 `1608p`、`1920p` 这种不存在的档位，所以按宽度判：
 * 3840×1920（4K 2:1）→ 2160p、1920×808（1080p 宽银幕）→ 1080p。
 */
export function tierHeight(width: number, height: number): number {
  const w = Number.isFinite(width) ? width : 0
  const h = Number.isFinite(height) ? height : 0
  if (w >= 3400) return 2160
  if (w >= 2300) return 1440
  if (w >= 1700) return 1080
  if (w >= 1100) return 720
  if (w >= 750) return 480
  if (w >= 550) return 360
  if (h >= 1600) return 2160
  if (h >= 1300) return 1440
  if (h >= 1000) return 1080
  if (h >= 760) return 1080
  if (h >= 640) return 720
  if (h >= 400) return 480
  if (h > 0) return 360
  return 0
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
    if (n.kind === 'movie' && n.edition) parts.push(dots(n.edition))
  }
  const tier = tierHeight(0, n.height)
  if (tier > 0) parts.push(`${tier}p`)
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
