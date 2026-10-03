// bun test app/src/main/cards.test.ts
// （在仓库根目录或 app/ 下都能跑：bun 1.4 会读 tsconfig.json 的 paths，
//   `@shared/*` → `app/src/shared/*`（app/tsconfig.json）或 `<repo>/app/src/shared/*`（根 tsconfig）。
//   `@tui/*` 在根 tsconfig 里也配了；app/src/main/cards.ts 为了两条路径都能跑，内部用的是相对导入。
//   别名解析只用于类型，运行时靠 bun 自己的 TS 支持。）
//
// 断言的是「卡片应该怎么走」：target.type 优先于 id 猜测，URL 形式的 id 不是 ID。
import { expect, test } from 'bun:test'
import { detailPoster, posterOf, posterUrl, toCards } from './cards.ts'

const item = (over: Record<string, unknown>) => ({ title: '片子', ...over })

test('search cards retain movie/TV hints without guessing from a single episode', () => {
  const cards = toCards('tencent', { items: [
    { id: 'movie', title: '电影', kind: 'video', meta: { media_type: 'movie' } },
    { id: 'tv', title: '剧集', raw: { category: '电视剧' } },
    { id: 'unknown', title: '未知', kind: 'video', episode_count: 1 },
  ] })
  expect(cards.map(c => c.mediaKind)).toEqual(['movie', 'show', undefined])
})

test('没有明确 target 时，只有 target.id 的条目按 ID 打开详情', () => {
  const cards = toCards('youku', {
    items: [item({ title: '长安', target: { id: 'show-1' } })],
  })
  expect(cards).toHaveLength(1)
  expect(cards[0]!.target).toBe('detail')
  expect(cards[0]!.id).toBe('show-1')
  expect(cards[0]!.query).toBeUndefined()
  expect(cards[0]!.video).toBeUndefined()
})

test('顶层 id 可直接当详情 ID 用', () => {
  const [c] = toCards('tencent', { items: [item({ id: 'cid-9' })] })
  expect(c!.target).toBe('detail')
  expect(c!.id).toBe('cid-9')
})

test('URL 形式的 id 不是 ID；此时 target.detail 给的 id 才是', () => {
  const urlOnly = toCards('youku', { items: [item({ id: 'https://v.youku.com/v_show/x' })] })
  expect(urlOnly[0]!.target).toBe('search')
  expect(urlOnly[0]!.id).toBe('')
  expect(urlOnly[0]!.query).toBe('片子')

  const withTarget = toCards('youku', {
    items: [item({ id: 'https://v.youku.com/v_show/x', target: { type: 'detail', id: 'real-1' } })],
  })
  expect(withTarget[0]!.target).toBe('detail')
  expect(withTarget[0]!.id).toBe('real-1')
})

test('target.detail 的 id 也是 URL 时退回搜索', () => {
  const [c] = toCards('youku', { items: [item({ target: { type: 'detail', id: '//v.youku.com/x' } })] })
  expect(c!.target).toBe('search')
  expect(c!.query).toBe('片子')
})

test('search target 带上网关给的搜索词', () => {
  const [c] = toCards('tencent', {
    items: [item({ id: 'cid-1', target: { type: 'search', query: '关键词' } })],
  })
  expect(c!.target).toBe('search')
  expect(c!.query).toBe('关键词')
})

test('search target 没给 query 时用标题', () => {
  const [c] = toCards('tencent', { items: [item({ target: { type: 'search' } })] })
  expect(c!.target).toBe('search')
  expect(c!.query).toBe('片子')
})

test('search target 压过看起来正常的 id（不再误开详情）', () => {
  const [c] = toCards('youku', { items: [item({ seriesId: '12345', target: { type: 'search', query: '别名' } })] })
  expect(c!.target).toBe('search')
  expect(c!.query).toBe('别名')
})

test('unavailable 带原因', () => {
  const [c] = toCards('hongguo', { items: [item({ target: { type: 'unavailable', reason: '还没上线' } })] })
  expect(c!.target).toBe('unavailable')
  expect(c!.reason).toBe('还没上线')
})

test('预约条目即使有 id 也是 unavailable', () => {
  const [c] = toCards('youku', { items: [item({ id: 'x', kind: 'reservation' })] })
  expect(c!.target).toBe('unavailable')
  expect(c!.reason).toBe('预约内容尚不可下载')
  // 榜单标记的预约（contentType=reservation）同理
  const [r] = toCards('youku', { contentType: 'reservation', items: [item({ id: 'y' })] })
  expect(r!.target).toBe('unavailable')
})

test('channel 条目不进卡片列表', () => {
  const cards = toCards('hongguo', {
    items: [item({ kind: 'channel', target: { type: 'channel', sectionId: 's1' } }), item({ id: 'ok' })],
  })
  expect(cards).toHaveLength(1)
  expect(cards[0]!.id).toBe('ok')
})

test('channel 条目不占去重 key，后面同 ID 的正片仍然出现', () => {
  // 同一个 ID 先以 target.type=channel 出现（子频道入口），不能把正片挤掉。
  const cards = toCards('hongguo', {
    items: [item({ id: 'share-1', target: { type: 'channel', sectionId: 's1' } }), item({ id: 'share-1' })],
  })
  expect(cards).toHaveLength(1)
  expect(cards[0]!.target).toBe('detail')
})

test('优酷单视频：id 是 vid，走 video 而不是节目详情', () => {
  const [c] = toCards('youku', { items: [item({ title: '相关视频', target: { type: 'video', id: 'Xvid123' } })] })
  expect(c!.target).toBe('detail')
  expect(c!.video).toBe(true)
  expect(c!.id).toBe('Xvid123')
})

test('video target 没带可用 id 时退回搜索', () => {
  const [c] = toCards('youku', { items: [item({ title: '相关视频', target: { type: 'video' } })] })
  expect(c!.target).toBe('search')
  expect(c!.video).toBeUndefined()
})

test('kind=video 的普通条目不受影响（vid 不被当成节目 ID）', () => {
  const [c] = toCards('youku', { items: [item({ id: 'show-2', vid: 'v-9', kind: 'video' })] })
  expect(c!.target).toBe('detail')
  expect(c!.id).toBe('show-2')
  expect(c!.video).toBeUndefined()
})

test('广告 / 预告 / 无标题被丢掉，同 ID 去重', () => {
  const cards = toCards('youku', {
    items: [
      item({ id: 'a', kind: '广告' }),
      item({ id: 'b', kind: 'trailer' }),
      item({ title: '' }),
      item({ id: 'c' }),
      item({ id: 'c', title: '重复' }),
      item({ id: 'https://x/y', title: '同标题' }),
      item({ title: '同标题' }),
    ],
  })
  expect(cards.map((c) => c.id)).toEqual(['c', ''])
  expect(cards).toHaveLength(2)
})

test('协议相对的海报地址补成 https', () => {
  expect(posterUrl('//img.example.com/a.jpg')).toBe('https://img.example.com/a.jpg')
  expect(posterUrl('http://img.example.com/a.jpg')).toBe('http://img.example.com/a.jpg')
  expect(posterUrl('data:image/png;base64,xx')).toBe('')
  expect(posterOf({ cover: '//img.example.com/a.jpg' })).toBe('https://img.example.com/a.jpg')
})

test('海报：对象 / 数组 / 数字字段', () => {
  expect(posterOf({ cover: { url: 'https://a/1.jpg' } })).toBe('https://a/1.jpg')
  expect(posterOf({ cover: { src: 'https://a/2.jpg' } })).toBe('https://a/2.jpg')
  expect(posterOf({ cover: [{ url: 'https://a/3.jpg' }, { url: 'https://a/4.jpg' }] })).toBe('https://a/3.jpg')
  expect(posterOf({ cover: [{}, { url: 'https://a/5.jpg' }] })).toBe('')
  expect(posterOf({ vertical_pic: 'https://a/6.jpg' })).toBe('https://a/6.jpg')
})

test('海报：协议相对值补全 https 后按原优先级采用，不是跳过后面的键', () => {
  expect(posterOf({ cover: 'not-a-url', poster: 'https://a/7.jpg' })).toBe('https://a/7.jpg')
  expect(posterOf({ vertical_pic: '//a/8.jpg', thumbUrl: 'https://a/9.jpg' })).toBe('https://a/8.jpg')
  expect(posterOf({ cover: '', poster: null, img: 'https://a/10.jpg' })).toBe('https://a/10.jpg')
  expect(posterOf(undefined, {}, { img: 'https://a/11.jpg' })).toBe('https://a/11.jpg')
  expect(posterOf({ cover: 'javascript:alert(1)' }, { img: 'https://a/12.jpg' })).toBe('https://a/12.jpg')
})

test('海报：短名 img/image 里的非 URL 值（base64）挡不住后面的真地址', () => {
  expect(posterOf({ img: 'data:image/png;base64,AAAA', thumbUrl: 'https://a/14.jpg' })).toBe('https://a/14.jpg')
  expect(posterOf({ image: '', posterUrl: 'https://a/15.jpg' })).toBe('https://a/15.jpg')
  // 只有短名可用时仍然能用（只要它是 URL）
  expect(posterOf({ img: 'https://a/16.jpg' })).toBe('https://a/16.jpg')
})

test('卡片带上海报 / 简介 / 名次 / 会员', () => {
  const [c] = toCards('youku', {
    contentType: 'rank',
    items: [
      item({
        id: 'r1',
        subtitle: '一句简介',
        score: '8.6',
        rank: 3,
        vip: true,
        cover: '//a/13.jpg',
        episodeCount: 24,
        category: '电视剧',
        year: '2024',
      }),
    ],
  })
  expect(c!.poster).toBe('https://a/13.jpg')
  expect(c!.desc).toBe('一句简介')
  expect(c!.score).toBe('8.6')
  expect(c!.rank).toBe(3)
  expect(c!.vip).toBe(true)
  expect(c!.meta).toBe('电视剧 · 2024 · 24 集')
})

test('meta.target 和顶层 target 一样认', () => {
  const [c] = toCards('tencent', { items: [item({ meta: { target: { type: 'search', query: 'q' } } })] })
  expect(c!.target).toBe('search')
  expect(c!.query).toBe('q')
})

test('详情海报：data / show / raw.show / video / 第一集依次兜底', () => {
  expect(detailPoster({ title: 'x' })).toBe('')
  expect(detailPoster({ raw: { cover: 'https://a/20.jpg' } })).toBe('https://a/20.jpg')
  expect(detailPoster({ raw: { show: { cover: 'https://a/21.jpg' } } })).toBe('https://a/21.jpg')
  expect(detailPoster({ show: { vertical_pic: '//a/22.jpg' } })).toBe('https://a/22.jpg')
  expect(detailPoster({ video: { cover: 'https://a/23.jpg' } })).toBe('https://a/23.jpg')
  expect(detailPoster({ episodes: [{ cover: 'https://a/24.jpg' }] })).toBe('https://a/24.jpg')
  expect(detailPoster({ cover: 'https://a/25.jpg', raw: { cover: 'https://a/26.jpg' } })).toBe('https://a/25.jpg')
})
