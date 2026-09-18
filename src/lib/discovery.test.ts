import { test, expect } from 'bun:test'
import { Discovery, discoveryRows, type Invoke } from './discovery'
const sections = [
  {
    id: 'a',
    title: '榜单甲',
    mode: 'rank',
    contentType: 'rank',
    available: true,
  },
  {
    id: 'b',
    title: '榜单乙',
    mode: 'rank',
    contentType: 'rank',
    available: true,
  },
]
const row = (id: string, rank = 1) => ({
  seriesId: id,
  title: '标题' + id,
  rank,
  target: { type: 'detail', id },
})
test('discovery keeps actual rank and explicit title-search target without an ID', () => {
  const rows = discoveryRows('tencent', {
    contentType: 'rank',
    items: [
      { title: '无 CID', rank: 7, target: { type: 'search', query: '无 CID' } },
      { title: '预告', kind: 'trailer' },
    ],
  })
  expect(rows).toHaveLength(1)
  expect(rows[0].id).toBe('')
  expect(rows[0].target?.type).toBe('search')
  expect(rows[0].rank).toBe(7)
  expect(
    discoveryRows('youku', {
      contentType: 'recommendation',
      items: [row('1')],
    })[0].rank,
  ).toBeUndefined()
})
test('cache restores selection per section/filter and refresh bypasses cache', async () => {
  let calls = 0,
    now = 0
  const d = new Discovery(
    async (_, a) =>
      a === 'browse_catalog'
        ? { sections }
        : (calls++, { items: [row('1'), row('2')] }),
    () => {},
    () => now,
  )
  await d.open('hongguo', 'rank')
  d.view.cursor = 1
  await d.choose(1)
  await d.choose(0)
  expect(d.view.cursor).toBe(1)
  expect(calls).toBe(2)
  await d.filter('genre', 'comic')
  d.view.cursor = 1
  await d.filter('genre', 'human')
  await d.filter('genre', 'comic')
  expect(d.view.cursor).toBe(1)
  const before = calls
  await d.load(false, true)
  expect(calls).toBe(before + 1)
  now = 300001
  await d.open('hongguo', 'rank')
  expect(calls).toBe(before + 2)
})
test('late platform responses are discarded', async () => {
  let done!: (v: Record<string, unknown>) => void
  const invoke: Invoke = async (p, a) =>
    a === 'browse_catalog'
      ? { sections }
      : p === 'youku'
        ? new Promise((resolve) => (done = resolve))
        : { items: [row('new')] }
  const d = new Discovery(invoke, () => {})
  const old = d.open('youku', 'rank')
  await Bun.sleep(1)
  await d.open('tencent', 'rank')
  done({ items: [row('old')] })
  await old
  expect(d.view.provider).toBe('tencent')
  expect(d.view.rows[0].id).toBe('new')
  expect(d.view.loading).toBe(false)
})
test('one request per cursor, sends seen IDs, stops duplicate or stagnant pages', async () => {
  let count = 0,
    seen: unknown
  const d = new Discovery(
    async (_, a, i) => {
      if (a === 'browse_catalog') return { sections }
      count++
      seen = i.seenIds
      await Bun.sleep(5)
      return { items: [row('1', 9)], hasMore: true, nextCursor: '10' }
    },
    () => {},
  )
  await d.open('hongguo', 'rank')
  await Promise.all([d.load(true), d.load(true), d.load(true)])
  expect(count).toBe(2)
  expect(seen).toBe('1')
  expect(d.view.rows).toHaveLength(1)
  expect(d.view.rows[0].rank).toBe(9)
  expect(d.view.more).toBe(false)
  expect(d.view.notice).toContain('停止分页')
})
test('unsupported catalog alone enters bounded compatibility; denial does not', async () => {
  const d = new Discovery(
    async (_, a) => {
      if (a === 'browse_catalog') throw Error('unknown action browse_catalog')
      return { items: [row('1')] }
    },
    () => {},
  )
  await d.open('youku')
  expect(d.view.compatibility).toBe(true)
  expect(d.view.rows[0].rank).toBeUndefined()
  const denied = new Discovery(
    async () => {
      throw Error('HTTP 403 forbidden')
    },
    () => {},
  )
  await denied.open('tencent')
  expect(denied.view.compatibility).toBe(false)
  expect(denied.view.error).toContain('403')
  expect(denied.view.rows).toHaveLength(0)
})

test('holding an arrow at the last section does not restart its request', async () => {
  let calls = 0
  const d = new Discovery(
    async (_, a) =>
      a === 'browse_catalog'
        ? { sections }
        : (calls++, { items: [row('one')] }),
    () => {},
  )
  await d.open('youku', 'rank')
  await d.choose(1)
  await Promise.all(Array.from({ length: 30 }, () => d.choose(1)))
  expect(calls).toBe(2)
})
