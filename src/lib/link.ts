const URL_RE = /https?:\/\/[^\s<>"'，。、]+/gi
const BARE_RE = /(?:^|\s)((?:www\.)?(?:v\.)?(?:ies)?douyin\.com\/[^\s<>"'，。、]+)/i
const TRAIL = /[.,;:!?）)】」'"]+$/u

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
