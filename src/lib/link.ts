const URL_RE = /https?:\/\/[^\s<>"'，。、]+/gi
const BARE_RE = /(?:^|\s)((?:www\.)?(?:v\.)?(?:ies)?douyin\.com\/[^\s<>"'，。、]+)/i
const TRAIL = /[.,;:!?）)】」'"]+$/u
const QQ_URL_RE =
  /https?:\/\/(?:[\w-]+\.)*(?:v\.qq\.com|film\.qq\.com)\/[^\s<>"'，。、]+/gi
const QQ_BARE_RE =
  /(?:^|[\s"'=(])((?:m\.)?v\.qq\.com\/[^\s<>"'，。、]+|film\.qq\.com\/[^\s<>"'，。、]+)/gi

export type TencentLinkIds = { vid: string; cid: string; url: string }

/** Accept video-page URLs only; show IDs and unrelated hosts are not video IDs. */
export function extractYoukuVideoId(text: string): string {
  const urls = text.match(/https?:\/\/[^\s<>"'，。、]+|(?:[a-z0-9-]+\.)*youku\.com\/[^\s<>"'，。、]+/gi) ?? []
  for (const raw of urls) {
    try {
      const url = new URL((/^https?:/i.test(raw) ? raw : `https://${raw}`).replace(TRAIL, ''))
      if (url.hostname !== 'youku.com' && !url.hostname.endsWith('.youku.com')) continue
      const path = decodeURIComponent(url.pathname)
      const id = /^\/v_show\/id_([A-Za-z0-9=]+)\.html\/?$/.exec(path)?.[1]
        || url.searchParams.get('vid') || url.searchParams.get('videoId') || ''
      if (/^X[A-Za-z0-9]+={0,2}$/.test(id)) return id
    } catch { /* malformed URL */ }
  }
  return ''
}

/** Parse v.qq.com / m.v.qq.com / film.qq.com HTML page URLs (up to two). */
export function extractTencentLinks(text: string, limit = 2): TencentLinkIds[] {
  const raw = text.trim()
  if (!raw) return []
  const urls: string[] = []
  const seen = new Set<string>()
  const push = (u: string) => {
    u = u.replace(TRAIL, '').trim()
    if (!u) return
    const key = u.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    urls.push(u)
  }
  QQ_URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = QQ_URL_RE.exec(raw))) push(m[0])
  QQ_BARE_RE.lastIndex = 0
  while ((m = QQ_BARE_RE.exec(raw))) {
    if (m[1]) push(`https://${m[1]}`)
  }
  const out: TencentLinkIds[] = []
  for (const u of urls) {
    const ids = parseTencentURL(u)
    if (!ids.vid && !ids.cid) continue
    out.push(ids)
    if (out.length >= limit) break
  }
  return out
}

export function extractTencentLink(text: string): TencentLinkIds | null {
  return extractTencentLinks(text, 1)[0] ?? null
}

export function parseTencentURL(raw: string): TencentLinkIds {
  const empty = { vid: '', cid: '', url: '' }
  try {
    const url = new URL((/^https?:/i.test(raw) ? raw : `https://${raw}`).replace(TRAIL, ''))
    const host = url.hostname.toLowerCase()
    if (
      host !== 'v.qq.com' &&
      !host.endsWith('.v.qq.com') &&
      host !== 'film.qq.com' &&
      !host.endsWith('.film.qq.com')
    ) {
      return empty
    }
    let vid = (url.searchParams.get('vid') || '').trim()
    let cid = (url.searchParams.get('cid') || '').trim()
    const path = decodeURIComponent(url.pathname)
    const cover = /\/(?:x\/)?cover\/([0-9a-zA-Z]+)/i.exec(path)
    if (!cid && cover) cid = cover[1] || ''
    const film = /\/video\/([0-9a-zA-Z]+)/i.exec(path)
    if (!cid && film) cid = film[1] || ''
    const page = /\/(?:x\/)?page\/([0-9a-zA-Z]+)/i.exec(path)
    if (!vid && page) vid = page[1] || ''
    if (!vid) {
      const base = path.replace(/\.html\/?$/i, '').split('/').filter(Boolean).pop() || ''
      if (isQQID(base) && base.toLowerCase() !== cid.toLowerCase()) {
        // /cover/{cid}.html → base==cid, skip; /cover/{cid}/{vid}.html → vid
        const segs = path.replace(/\.html\/?$/i, '').split('/').filter(Boolean)
        if (segs.length >= 2) {
          const last = segs[segs.length - 1] || ''
          const prev = segs[segs.length - 2] || ''
          if (/^cover$/i.test(prev) || /^video$/i.test(prev)) {
            /* cover-only */
          } else if (isQQID(last)) {
            vid = last
          }
        } else if (!cid) {
          vid = base
        }
      }
    }
    return { vid, cid, url: url.toString() }
  } catch {
    return empty
  }
}

function isQQID(s: string): boolean {
  return /^[0-9a-zA-Z]{11,15}$/.test(s)
}

export function extractDouyinURL(text: string): string {
  const raw = text.trim()
  if (!raw) return ''
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(raw))) {
    const url = m[0].replace(TRAIL, '')
    if (isDouyinHost(url)) return url
  }
  const bare = raw.match(BARE_RE)
  if (bare?.[1]) {
    const url = `https://${bare[1]}`.replace(TRAIL, '')
    if (isDouyinHost(url)) return url
  }
  return ''
}

export function isDouyinHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'douyin.com' || host.endsWith('.douyin.com') || host === 'iesdouyin.com' || host.endsWith('.iesdouyin.com')
  } catch {
    return false
  }
}

export function clipTitle(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if (!t) return '抖音视频'
  return t.length > max ? t.slice(0, max) : t
}
