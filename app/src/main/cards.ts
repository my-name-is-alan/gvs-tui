// 网关 browse/search 条目 → 界面卡片。
//
// 从 core.ts 抽出来单独成文件，一是保持纯映射（无 Electron / job 状态），
// 二是卡片字段的取法要能被 bun test 直接验证（见 cards.test.ts）。
//
// 这里的 `@tui/util.ts` 故意写成相对路径：bun test 不认 electron.vite 的
// `@tui` 别名，而相对路径在打包时同样能解析。所以本文件不要引入其他 `@tui/*`。
import { anyInt, isObj } from '../../../src/lib/util.ts'
import { mediaKindFromMetadata } from '../../../src/lib/media-kind.ts'
import type { Card, Provider } from '@shared/api'

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

/** 平台给出的伪 ID：空、字面量 null/nil、或者是个 URL（那只能拿来搜，不能当 ID）。 */
function isID(v: string): boolean {
  return !!v && v !== '<nil>' && v !== 'null' && !v.includes('://') && !v.startsWith('//')
}

/**
 * 海报候选字段。按顺序取第一个「能用的」值，所以列表顺序 = 优先级。
 * 优酷/腾讯/红果/黄果各平台的字段名混在一起，命中一个就走。
 *
 * 分两轮扫：先扫确定是 URL 的字段名，再扫 `img` / `pic` 这类短名
 * （历史上见过放 base64 的）。不然一个 `img: 'data:image/png;base64,…'`
 * 会把后面本来可用的 `thumbUrl` 挡掉。
 */
const POSTER_KEYS = [
  'poster',
  'cover',
  'verticalPic',
  'vertical_pic',
  'vertical_pic_url',
  'new_pic_vt',
  'vpic',
  'vImg',
  'showVthumbUrl',
  'showImg',
  'showThumbUrl',
  'thumbUrl',
  'vThumbUrl',
  'poster_url',
  'posterUrl',
  'cover_url',
  'coverUrl',
  'cover_img',
  'coverImg',
  'series_cover',
  'image_url',
  'imageUrl',
  'img_url',
  'imgUrl',
  'pic_url',
  'picUrl',
  'thumb_url',
  'thumbnail',
  'horizontal_pic',
  'horizontalImage',
  'horizontal_pic_url',
  'new_pic_hz',
]

/** 短名兜底：值未必是 URL，放在第二轮的末尾。 */
const POSTER_KEYS_FALLBACK = ['img', 'image', 'pic', 'thumb']

/** 值可能是字符串、{url|src|href}，也可能是数组（取第一个）。只做取值，不做校验。 */
function valueStr(v: unknown): string {
  if (Array.isArray(v)) return v.length ? valueStr(v[0]) : ''
  if (isObj(v)) return valueStr(v.url) || valueStr(v.src) || valueStr(v.href)
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number') return String(v)
  return ''
}

/**
 * 单个值 → 可用海报地址。协议相对的 `//host/x.jpg` 先补成 https 再校验，
 * 不然它会被误判成「非法值」而挡掉后面本来可用的字段。
 */
export function posterUrl(v: unknown): string {
  const s = valueStr(v)
  if (!s) return ''
  const abs = s.startsWith('//') ? `https:${s}` : s
  return /^https?:\/\//i.test(abs) ? abs : ''
}

/** 依次在多个对象上找海报：同一字段列表，先到先得。 */
export function posterOf(...objs: Array<Record<string, unknown> | undefined>): string {
  const found = scanPosters(objs, POSTER_KEYS)
  return found || scanPosters(objs, POSTER_KEYS_FALLBACK)
}

/** 每个对象内部按字段顺序找；对象之间也是先到先得。 */
function scanPosters(objs: Array<Record<string, unknown> | undefined>, keys: string[]): string {
  for (const o of objs) {
    if (!isObj(o)) continue
    for (const k of keys) {
      const url = posterUrl(o[k])
      if (url) return url
    }
  }
  return ''
}

/** 详情页的海报来源，顺序与网关回包结构一致（优酷详情可能把节目信息嵌在 `show` 里）。 */
export function detailPoster(data: Record<string, unknown>): string {
  const raw = isObj(data.raw) ? data.raw : {}
  const show = isObj(data.show) ? data.show : {}
  const rawShow = isObj(raw.show) ? raw.show : {}
  const video = isObj(data.video) ? data.video : {}
  const eps = Array.isArray(data.episodes) ? data.episodes : []
  const first = eps.find((e) => isObj(e)) as Record<string, unknown> | undefined
  return posterOf(data, show, raw, rawShow, video, first)
}

/**
 * 网关 browse/search 条目 → 卡片（字段取法与 TUI discoveryRows / parseSearch 一致，多带海报）。
 *
 * target 的优先级（docs/GATEWAY.md §6、TUI runtime.openRow）：
 *   target.type 明确给了就听它的 → detail / video / search / unavailable，channel 不进卡片列表。
 *   没给才按 id 猜：id 能当 ID 用就是 detail，否则按标题搜。
 */
export function toCards(provider: Provider, data: Record<string, unknown>): Card[] {
  const items = Array.isArray(data.items) ? data.items : Array.isArray(data.list) ? data.list : []
  const seen = new Set<string>()
  const out: Card[] = []
  for (const raw of items) {
    if (!isObj(raw)) continue
    const meta = isObj(raw.meta) ? raw.meta : {}
    const title = str(raw.title || raw.name || raw.seriesName || meta.title)
    const kind = str(raw.kind || meta.kind)
    if (!title || /advert|广告|trailer|预告|channel/.test(kind)) continue
    // 详情 ID 只看「顶层字段」：raw.vid 是优酷单视频的 vid，当节目 ID 用会打开错的详情。
    let id = str(raw.seriesId || raw.showId || raw.cid || raw.id || meta.seriesId || meta.showId || meta.cid)
    if (!isID(id)) id = ''
    const t = isObj(raw.target) ? raw.target : isObj(meta.target) ? meta.target : {}
    const tid = str(t.id)
    const type = str(t.type)
    // 子频道由 browse() 单独收进 channels，不进卡片列表，也不占去重 key。
    if (type === 'channel') continue
    const key = id || title
    if (seen.has(key)) continue
    seen.add(key)
    // 没有明确 target 时的兜底：ID 可用就当详情，否则只能按标题搜。
    let target: Card['target'] = id ? 'detail' : 'search'
    let reason = ''
    let query = id ? '' : title
    let video = false
    if (type === 'unavailable') {
      target = 'unavailable'
      reason = str(t.reason)
      query = ''
    } else if (type === 'search') {
      target = 'search'
      query = str(t.query) || title
    } else if (type === 'video') {
      // 优酷单视频：id 给的是 vid，不能拿去当节目 ID 查详情（走 detailFromLink）。
      id = isID(tid) ? tid : id
      target = id ? 'detail' : 'search'
      query = id ? '' : title
      video = !!id
    } else if (type === 'detail') {
      id = isID(tid) ? tid : id
      target = id ? 'detail' : 'search'
      query = id ? '' : title
    } else if (isID(tid)) {
      // 网关只给了 target.id、没写 type（TUI discoveryRows 也认这种）。
      id = tid
      target = 'detail'
      query = ''
    }
    if (data.contentType === 'reservation' || kind === 'reservation' || kind === '预约') {
      target = 'unavailable'
      reason = '预约内容尚不可下载'
      query = ''
      video = false
    }

    const year = str(raw.year || meta.year)
    const eps = anyInt(raw.episodeCount ?? meta.episodeCount ?? raw.episode_count)
    const category = str(raw.category || meta.category)
    const metaBits = [category !== '首页' ? category : '', year, eps > 1 ? `${eps} 集` : ''].filter(Boolean)
    out.push({
      provider,
      id,
      title,
      poster: posterOf(raw, meta),
      desc: str(raw.subtitle || raw.desc || meta.subtitle || meta.subTitle || meta.desc || raw.feature),
      meta: metaBits.join(' · '),
      score: str(raw.score || meta.score),
      rank: data.contentType === 'rank' && Number(raw.rank) > 0 ? Number(raw.rank) : undefined,
      vip: raw.vip === true || raw.is_vip === true || meta.vip === true,
      target,
      reason: reason || undefined,
      query: target === 'search' ? query || title : undefined,
      video: video || undefined,
      mediaKind: mediaKindFromMetadata(raw),
    })
  }
  return out
}
