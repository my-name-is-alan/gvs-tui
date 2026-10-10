import { test, expect, afterEach, spyOn } from 'bun:test'
import { Runtime } from './runtime'
import * as tunnel from './lib/tunnel'
import { viewMetrics } from './lib/ui-layout'
import { gridWindow } from './lib/grid'
import { GwClient } from './lib/client'
import { wrapLines, displayWidth } from './lib/text'
import { completedFilename, filename, folder } from './lib/name'
import { jobNaming } from './lib/jobs'
import { join } from 'node:path'
import { discoveryRows } from './lib/discovery'
const runtimes: Runtime[] = []
const start = async () => {
  const r = new Runtime({ simulate: true })
  runtimes.push(r)
  await Bun.sleep(110)
  return r
}
afterEach(() => {
  runtimes.splice(0).forEach((r) => r.close())
})

for (const [provider, vid] of [['youku', 'XNjUzMzM0MDI1Ng=='], ['tencent', 'g4102f0fkum']]) {
  test(`${provider} discovery VID opens detail without searching or downloading`, async () => {
    const r = await start()
    const x = r as any
    const calls: Array<{ provider: string; action: string; input: Record<string, string> }> = []
    x.cli.invoke = async (p: string, action: string, input: Record<string, string>) => {
      calls.push({ provider: p, action, input })
      return { title: '专区电影', vid, episodes: [{ vid: 'unrelated', title: '别的版本' }] }
    }
    const [row] = discoveryRows(provider, { items: [{ title: '专区电影', vid, target: { type: 'search' } }] })
    await x.openRow(row)
    expect(r.snapshot.scene).toBe('detail')
    expect(x.eps.map((e: { vid: string }) => e.vid)).toEqual([vid])
    expect(calls).toHaveLength(1)
    expect(calls[0].provider).toBe(provider)
    expect(calls[0].action).toBe(provider === 'youku' ? 'detail' : 'resolve')
    expect(calls[0].input.vid).toBe(vid)
  })
}

test('TUI episode-title toggle applies to new IQ tasks and previews while existing tasks keep their choice', async () => {
  const r = await start()
  const x = r as any
  x.detailProv = 'iq'
  x.detailTitle = '海外节目'
  x.detailInfo = { kind: 'show', year: 2026 }
  x.eps = [{ vid: 'one', title: '雨夜重逢', season: 2, number: 3, languages: [] }]
  r.handleKey('f4')
  x.setIdx = x.settingFields().indexOf('文件名单集标题')
  x.emit()
  expect(r.snapshot.settings?.find(s => s.label === '文件名单集标题')?.value).toStartWith('开')
  expect(x.taskFromEp(0).includeEpisodeTitle).toBe(true)
  r.handleKey('enter')
  expect(r.snapshot.settings?.find(s => s.label === '文件名单集标题')?.value).toStartWith('关')
  const off = x.taskFromEp(0)
  expect(off.includeEpisodeTitle).toBe(false)
  x.pending = [off]
  x.scene = 'confirm'
  x.emit()
  expect(r.snapshot.confirmation?.name).toContain('海外节目.S02E03.2026.')
  expect(r.snapshot.confirmation?.name).not.toContain('雨夜重逢')
  r.handleKey('f4')
  x.setIdx = x.settingFields().indexOf('文件名单集标题')
  r.handleKey('space')
  expect(x.cfg.includeEpisodeTitle).toBe(true)
  const on = x.taskFromEp(0)
  expect(completedFilename(jobNaming(on, x.cfg), { status: 'unavailable' })).toContain('.S02E03.雨夜重逢.2026.')
  const restored = JSON.parse(JSON.stringify(off))
  expect(jobNaming(restored, x.cfg).episodeTitle).toBeUndefined()
})

test.each(['iq', 'iqcn'] as const)('%s-only scope exposes TMDB settings and matching corrects a movie title, year, folder and filename', async (provider) => {
  const r = await start()
  const x = r as any
  x.keyInfo = { all: false, scope: [provider] }
  x.cli.invoke = async () => ({ title: '平台片名', year: 2026,
    episodes: [{ vid: 'iq-movie', title: '平台片名', number: 1 }] })
  x.detailProv = 'tencent'
  x.scene = 'search'
  x.query = provider === 'iqcn' ? 'https://www.iqiyi.com/v_abc123.html' : 'https://www.iq.com/album/test-movie'
  r.handleKey('enter')
  await Bun.sleep(1)
  expect(x.detailProv).toBe(provider)
  expect(x.detailId).toBe(x.query)
  expect(r.snapshot.detail?.kind).toBe('show')
  r.handleKey('m')
  expect(r.snapshot.detail?.kind).toBe('movie')
  r.handleKey('m')
  expect(r.snapshot.detail?.kind).toBe('show')
  r.handleKey('f4')
  expect(r.snapshot.settings?.some(s => s.label === 'TMDB Key')).toBe(true)
  expect(r.snapshot.settings?.some(s => s.label === 'TMDB 代理')).toBe(true)
  r.handleKey('esc')
  r.handleKey('enter')
  const hit = { id: 900001, name: '正式片名', title: 'Original Movie', year: 2025, overview: '', kind: 'movie' as const }
  x.cfg.tmdbKey = 'local-test-key'
  x.simulated = false
  x.work = async () => [hit]
  x.cli.invoke = () => { throw new Error('TMDB selection must not call gateway play') }
  try {
    r.handleKey('enter')
    await Bun.sleep(1)
    expect(r.snapshot.scene).toBe('tmdb')
    expect(r.snapshot.tmdbState).toBe('ready')
    expect(r.snapshot.tmdbHits).toEqual([hit])
    r.handleKey('enter')
    expect(r.snapshot.scene).toBe('confirm')
    expect(x.pending[0]).toMatchObject({ provider, namingVersion: 1, kind: 'movie', series: '正式片名', year: 2025, tmdbId: 900001,
      season: 0, episode: 0 })
    expect(r.snapshot.confirmation?.name).toStartWith('正式片名.2025.')
    expect(r.snapshot.confirmation?.name).toContain(`.${provider === 'iqcn' ? 'IQIYI' : 'IQ'}.WEB-DL.`)
    expect(r.snapshot.confirmation?.name).not.toContain('S01E01')
    expect(r.snapshot.confirmation?.directory).toEndWith('正式片名 (2025) {tmdb-900001}')
    expect(r.snapshot.jobs).toHaveLength(0)
  } finally { x.simulated = true }
})

test.each(['iq', 'iqcn'] as const)('%s series TMDB matching keeps the platform season and episode numbers across a batch', async (provider) => {
  const r = await start()
  const x = r as any
  x.cli.invoke = async () => ({ title: '平台剧名 第2季', year: 2026,
    episodes: [{ vid: 'iq-one', title: '雨夜重逢', number: 1 }, { vid: 'iq-two', title: '携手同行', number: 2 }] })
  await x.detail(provider, 'series')
  r.handleKey('a')
  r.handleKey('enter')
  x.cfg.tmdbKey = 'local-test-key'
  x.simulated = false
  x.work = async () => [{ id: 900002, name: '正式剧名', title: 'Original Series', year: 2023, overview: '', kind: 'show' }]
  try {
    r.handleKey('enter')
    await Bun.sleep(1)
    expect(r.snapshot.scene).toBe('tmdb')
    r.handleKey('enter')
    expect(x.pending.map((t: any) => [t.series, t.year, t.tmdbId, t.season, t.episode])).toEqual([
      ['正式剧名', 2023, 900002, 2, 1], ['正式剧名', 2023, 900002, 2, 2],
    ])
    expect(r.snapshot.confirmation?.name).toContain('正式剧名.S02E01.雨夜重逢.2023.')
    expect(r.snapshot.confirmation?.directory).toEndWith(join('正式剧名 (2023) {tmdb-900002}', 'Season 02'))
    const restored = JSON.parse(JSON.stringify(x.pending[1]))
    expect(completedFilename(jobNaming(restored, x.cfg), { status: 'unavailable' })).toContain('正式剧名.S02E02.携手同行.2023.')
  } finally { x.simulated = true }
})

test.each(['tencent', 'iqcn'] as const)('%s matched final season can use TMDB S04 for the batch while retaining all platform episode IDs and numbers', async (provider) => {
  const r = await start()
  const x = r as any
  x.cli.invoke = async () => ({ title: '诛仙 最终季', year: 2026, episodes: [
    { vid: 'ep10', title: '诛仙 最终季 第10话', number: 10 },
    { vid: 'ep11', title: '诛仙 最终季 第11话', number: 11 },
  ] })
  await x.detail(provider, 'final-season')
  x.pending = x.eps.map((_: unknown, i: number) => x.taskFromEp(i))
  x.scene = 'tmdb'
  x.tmdbHits = [{ id: 206484, name: '诛仙', year: 2022, title: '', kind: 'show' }]
  x.emit()
  r.handleKey('enter')
  expect(r.snapshot.scene).toBe('confirm')
  expect(r.snapshot.canSelectTmdbSeason).toBe(true)
  expect(x.pending.every((t: any) => t.season === 1)).toBe(true)
  const rows = [
    { number: 0, name: '特别篇', episodeCount: 2, airDate: '' },
    { number: 1, name: '第 1 季', episodeCount: 26, airDate: '2022-08-02' },
    { number: 4, name: '第 4 季', episodeCount: 26, airDate: '2026-08-21' },
  ]
  x.work = async () => ({ seasons: rows, warning: '' })
  r.handleKey('t')
  await Bun.sleep(1)
  expect(r.snapshot.tmdbSeasonPicker?.seasons).toEqual(rows)
  r.handleKey('end')
  r.handleKey('enter')
  expect(x.pending.map((t: any) => [t.vid, t.season, t.episode])).toEqual([['ep10', 4, 10], ['ep11', 4, 11]])
  expect(r.snapshot.confirmation?.name).toContain('诛仙.S04E10.诛仙.最终季.第10话.2022.')
  expect(r.snapshot.confirmation?.directory).toEndWith(join('诛仙 (2022) {tmdb-206484}', 'Season 04'))
  const restored = JSON.parse(JSON.stringify(x.pending[1]))
  expect(completedFilename(jobNaming(restored, x.cfg), { status: 'probed', height: 2160, codec: 'HEVC' })).toContain('.S04E11.')
  r.handleKey('t')
  await Bun.sleep(1)
  r.handleKey('down')
  r.handleKey('enter')
  expect(x.pending.every((t: any) => t.season === 0)).toBe(true)
  expect(r.snapshot.confirmation?.directory).toEndWith('Season 00')
  r.handleKey('t')
  await Bun.sleep(1)
  r.handleKey('enter') // platform numbering
  expect(x.pending.every((t: any) => t.season === 1)).toBe(true)
})

test('TMDB season failures and cancelled requests keep the matched title and previous output numbers', async () => {
  const r = await start()
  const x = r as any
  x.detailProv = 'tencent'
  x.detailTitle = '诛仙 最终季'
  x.eps = [{ vid: 'ep10', title: '第10话', number: 10, languages: [] }]
  x.pending = [{ ...x.taskFromEp(0), series: '诛仙', nameDots: '诛仙', season: 4, tmdbId: 206484, year: 2022 }]
  x.scene = 'confirm'
  x.work = async () => { throw new Error('季列表连接失败') }
  r.handleKey('t')
  await Bun.sleep(1)
  expect(r.snapshot.tmdbSeasonPicker?.state).toBe('error')
  r.handleKey('esc')
  expect(r.snapshot.scene).toBe('confirm')
  expect(x.pending[0]).toMatchObject({ tmdbId: 206484, season: 4, episode: 10 })
  let release!: (v: unknown) => void
  x.work = () => new Promise(resolve => { release = resolve })
  r.handleKey('t')
  expect(r.snapshot.tmdbSeasonPicker?.state).toBe('loading')
  r.handleKey('s')
  release({ seasons: [{ number: 1, name: '第 1 季', episodeCount: 26, airDate: '' }], warning: '' })
  await Bun.sleep(1)
  expect(r.snapshot.scene).toBe('confirm')
  expect(r.snapshot.tmdbSeasonPicker).toBeUndefined()
  expect(x.pending[0].season).toBe(4)
})

test.each(['iq', 'iqcn'] as const)('%s without a TMDB key proceeds normally and a lookup failure remains skippable', async (provider) => {
  const r = await start()
  const x = r as any
  x.cli.invoke = async () => ({ title: '平台片名', year: 2026, episodes: [{ vid: 'iq-one', title: '第1集', number: 1 }] })
  await x.detail(provider, 'album')
  r.handleKey('enter')
  x.simulated = false
  x.work = () => { throw new Error('TMDB lookup should require a key') }
  try {
    r.handleKey('enter')
    await Bun.sleep(1)
    expect(r.snapshot.scene).toBe('confirm')
    expect(x.pending[0].tmdbId).toBe(0)
    x.scene = 'quality'
    x.cfg.tmdbKey = 'local-test-key'
    x.work = async () => { throw new Error('TMDB 连接失败') }
    r.handleKey('enter')
    await Bun.sleep(1)
    expect(r.snapshot.scene).toBe('tmdb')
    expect(r.snapshot.tmdbState).toBe('error')
    expect(r.snapshot.status).toContain('TMDB 连接失败')
    r.handleKey('s')
    expect(r.snapshot.scene).toBe('confirm')
    expect(x.pending[0]).toMatchObject({ series: '平台片名', year: 2026, tmdbId: 0 })
    expect(r.snapshot.confirmation?.directory).not.toContain('{tmdb-')
    expect(r.snapshot.jobs).toHaveLength(0)
  } finally { x.simulated = true }
})

test('tunnel recovery replaces its warning for both fast and slow reconnects', async () => {
  const r = await start()
  const internal = r as any
  let report!: Parameters<typeof tunnel.runTunnel>[2]
  const run = spyOn(tunnel, 'runTunnel').mockImplementation((_host, _key, onStatus) => { report = onStatus })
  let now = 100_000
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  try {
    internal.queueEnsureYouku = () => {}
    internal.say('搜索完成', 'ok')
    internal.openTunnel()
    report(true, '', 'ws')
    expect(r.snapshot.status).toBe('搜索完成')
    for (const delay of [1000, 9000]) {
      report(false, 'closed', 'ws')
      expect(r.snapshot.tunnelOk).toBe(false)
      expect(r.snapshot.status).toContain('隧道断开')
      expect(r.snapshot.statusKind).toBe('warn')
      now += delay
      report(true, '', 'ws')
      expect(r.snapshot.tunnelOk).toBe(true)
      expect(r.snapshot.tunnelError).toBeUndefined()
      expect(r.snapshot.status).toContain('隧道已恢复')
      expect(r.snapshot.statusKind).toBe('ok')
    }
  } finally {
    clock.mockRestore()
    run.mockRestore()
  }
})

test('tunnel retries and recovery preserve newer operation messages', async () => {
  const r = await start()
  const internal = r as any
  let report!: Parameters<typeof tunnel.runTunnel>[2]
  const run = spyOn(tunnel, 'runTunnel').mockImplementation((_host, _key, onStatus) => { report = onStatus })
  let now = 100_000
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  try {
    internal.queueEnsureYouku = () => {}
    internal.openTunnel()
    for (const delay of [1000, 9000]) {
      report(false, 'connection refused', 'ws')
      expect(r.snapshot.status).toBe('隧道断开 connection refused')
      internal.say('搜索失败，请重试', 'err')
      report(false, 'closed', 'ws')
      expect(r.snapshot.status).toBe('搜索失败，请重试')
      now += delay
      report(true, '', 'ws')
      expect(r.snapshot.tunnelOk).toBe(true)
      expect(r.snapshot.status).toBe('搜索失败，请重试')
      expect(r.snapshot.statusKind).toBe('err')
    }
  } finally {
    clock.mockRestore()
    run.mockRestore()
  }
})

test('restarting a tunnel clears its old warning and ignores obsolete callbacks', async () => {
  const r = await start()
  const internal = r as any
  const reports: Parameters<typeof tunnel.runTunnel>[2][] = []
  const run = spyOn(tunnel, 'runTunnel').mockImplementation((_host, _key, onStatus) => { reports.push(onStatus) })
  try {
    internal.queueEnsureYouku = () => {}
    internal.openTunnel()
    reports[0]!(false, 'closed', 'ws')
    internal.restartTunnel()
    reports[1]!(true, '', 'ws')
    expect(r.snapshot.tunnelOk).toBe(true)
    expect(r.snapshot.status).toContain('隧道已恢复')
    reports[0]!(false, 'closed', 'ws')
    expect(r.snapshot.tunnelOk).toBe(true)
    expect(r.snapshot.status).toContain('隧道已恢复')
    r.close()
    reports[1]!(false, 'closed', 'ws')
    expect(r.snapshot.tunnelOk).toBe(true)
  } finally { run.mockRestore() }
})

test('workspace navigation, detail grid, return position, settings and tasks context', async () => {
  const r = await start()
  r.resize(80, 24)
  r.handleKey('down')
  r.handleKey('down')
  expect(r.snapshot.workspace?.cursor).toBe(2)
  r.handleKey('f4')
  r.handleKey('esc')
  expect(r.snapshot.scene).toBe('workspace')
  expect(r.snapshot.workspace?.cursor).toBe(2)
  r.handleKey('enter')
  await Bun.sleep(70)
  expect(r.snapshot.scene).toBe('detail')
  r.handleKey('down')
  expect(r.snapshot.cursor).toBe(
    gridWindow(r.snapshot.episodes!.length, 0, 78, 1).perRow,
  )
  r.resize(140, 40)
  const before = r.snapshot.cursor
  r.handleKey('down')
  expect(r.snapshot.cursor).toBe(
    before + gridWindow(r.snapshot.episodes!.length, 0, 138, 1).perRow,
  )
  r.handleKey('f3')
  r.handleKey('esc')
  expect(r.snapshot.scene).toBe('detail')
  r.handleKey('esc')
  expect(r.snapshot.workspace?.cursor).toBe(2)
})
test('download requires final confirmation, Esc never queues, repeated Enter cannot duplicate', async () => {
  const r = await start()
  r.handleKey('enter')
  await Bun.sleep(70)
  r.handleKey('enter')
  expect(r.snapshot.scene).toBe('quality')
  expect(r.snapshot.jobs).toHaveLength(0)
  r.handleKey('enter')
  expect(r.snapshot.scene).toBe('confirm')
  r.handleKey('esc')
  expect(r.snapshot.scene).toBe('quality')
  expect(r.snapshot.jobs).toHaveLength(0)
  // Exercise the same explicit TMDB back transition without network.
  const internal = r as any
  internal.scene = 'tmdb'
  r.handleKey('esc')
  expect(r.snapshot.scene).toBe('quality')
  expect(r.snapshot.jobs).toHaveLength(0)
  r.handleKey('enter')
  r.handleKey('enter')
  r.handleKey('enter')
  expect(r.snapshot.jobs).toHaveLength(1)
})
test('probe failure blocks progression and search text navigation is not app navigation', async () => {
  const r = await start()
  r.handleKey('f2')
  r.set('query', '长安夜雨')
  r.handleKey('left')
  r.handleKey('down')
  expect(r.snapshot.scene).toBe('search')
  expect(r.snapshot.query).toBe('长安夜雨')
  r.handleKey('enter')
  await Bun.sleep(70)
  r.handleKey('enter')
  await Bun.sleep(70)
  r.handleKey('enter')
  ;(r as any).failProbe('拒绝', false)
  r.handleKey('x')
  expect(r.snapshot.qualities).toHaveLength(0)
  expect(r.snapshot.jobs).toHaveLength(0)
})
test('Tencent title target presents candidates, details return to candidates', async () => {
  const r = await start()
  r.handleKey('2', { alt: true })
  await Bun.sleep(110)
  r.handleKey('enter')
  await Bun.sleep(70)
  expect(r.snapshot.scene).toBe('results')
  expect(r.snapshot.jobs).toHaveLength(0)
  r.handleKey('down')
  r.handleKey('enter')
  await Bun.sleep(70)
  expect(r.snapshot.scene).toBe('detail')
  r.handleKey('esc')
  expect(r.snapshot.scene).toBe('results')
  expect(r.snapshot.cursor).toBe(1)
})
test('held down clamps at more; page only fetched by Enter', async () => {
  const r = await start()
  r.handleKey('3', { alt: true })
  await Bun.sleep(110)
  for (let i = 0; i < 80; i++) r.handleKey('down')
  expect(r.snapshot.workspace?.rows).toHaveLength(12)
  expect(r.snapshot.workspace?.cursor).toBe(12)
  r.handleKey('enter')
  r.handleKey('enter')
  await Bun.sleep(70)
  expect(r.snapshot.workspace?.rows).toHaveLength(24)
})
test('empty scopes deny access and long Chinese logs wrap without data loss', () => {
  expect(new GwClient('http://test', '').allows([], false, 'youku')).toBe(false)
  const source = '长日志'.repeat(100),
    lines = wrapLines(source, 78)
  expect(lines.join('')).toBe(source)
  expect(lines.every((l) => displayWidth(l) <= 78)).toBe(true)
})

test('selected Tencent quality must resolve before confirmation; failure can retry', async () => {
  const r = await start()
  r.handleKey('enter')
  await Bun.sleep(70)
  r.handleKey('enter')
  const internal = r as any
  internal.detailProv = 'tencent'
  internal.simulated = false
  let requests = 0
  internal.cli.invoke = async () => {
    requests++
    if (requests === 1) throw Error('upstream unavailable')
    return { video: { url: 'https://example.invalid/video.mp4' } }
  }
  r.handleKey('enter')
  await Bun.sleep(5)
  expect(r.snapshot.scene).toBe('quality')
  expect(r.snapshot.status).toContain('探测失败')
  expect(r.snapshot.jobs).toHaveLength(0)
  r.handleKey('enter')
  await Bun.sleep(5)
  expect(r.snapshot.scene).toBe('confirm')
  expect(requests).toBe(2)
  expect(r.snapshot.jobs).toHaveLength(0)
  internal.simulated = true
})
test('Tencent afterQuality accepts formats-only catalog (no top-level video.url)', async () => {
  const r = await start()
  r.handleKey('enter')
  await Bun.sleep(70)
  r.handleKey('enter')
  const internal = r as any
  internal.detailProv = 'tencent'
  internal.simulated = false
  internal.cli.invoke = async () => ({
    formats: [
      { id: 16, name: 'fhd', cname: '蓝光', caption: 'soft', width: 1920, height: 1080 },
    ],
    has_url: false,
  })
  r.handleKey('enter')
  await Bun.sleep(5)
  expect(r.snapshot.scene).toBe('confirm')
  expect(r.snapshot.status).not.toContain('探测失败')
  internal.simulated = true
})
test('Tencent afterQuality surfaces network_error instead of missing-url mask', async () => {
  const r = await start()
  r.handleKey('enter')
  await Bun.sleep(70)
  r.handleKey('enter')
  const internal = r as any
  internal.detailProv = 'tencent'
  internal.simulated = false
  internal.cli.invoke = async () => ({
    network_error: true,
    error: 'TV play request failed',
    formats: [{ name: 'fhd' }],
  })
  r.handleKey('enter')
  await Bun.sleep(5)
  expect(r.snapshot.scene).toBe('quality')
  expect(r.snapshot.status).toContain('探测失败')
  expect(r.snapshot.status).toMatch(/TV|网络|取流/)
  internal.simulated = true
})
test('platform switched from search loads its own workspace, never shows prior platform rows', async () => {
  const r = await start()
  r.handleKey('f2')
  r.handleKey('3', { alt: true })
  await Bun.sleep(110)
  r.handleKey('esc')
  expect(r.snapshot.workspace?.provider).toBe('hongguo')
  expect(r.snapshot.workspace?.rows.every((row) => row.sub === 'hongguo')).toBe(
    true,
  )
})
test('late failed search cannot overwrite new platform status', async () => {
  const r = await start()
  const internal = r as any
  const original = internal.cli.invoke
  let reject!: (e: Error) => void
  internal.cli.invoke = async (p: string, a: string, i: any) =>
    a === 'search'
      ? new Promise((_resolve, fail) => (reject = fail))
      : original(p, a, i)
  r.handleKey('f2')
  r.set('query', '旧请求')
  r.handleKey('enter')
  r.handleKey('3', { alt: true })
  await Bun.sleep(110)
  reject(Error('STALE FAILURE'))
  await Bun.sleep(5)
  expect(r.snapshot.status).not.toContain('STALE FAILURE')
})

test('nested search video opens selected video detail without automatic queue',async()=>{
 const r=await start();const internal=r as any
 internal.cli.invoke=async()=>({title:'相关视频',episodes:[]})
 internal.scene='results';internal.rows=[{title:'相关视频',id:'Xvideo',sub:'youku',target:{type:'video',id:'Xvideo'}}]
 r.handleKey('enter');await Bun.sleep(10)
 expect(r.snapshot.scene).toBe('detail');expect(r.snapshot.episodes?.[0].vid).toBe('Xvideo');expect(r.snapshot.jobs).toHaveLength(0)
 r.handleKey('esc');expect(r.snapshot.scene).toBe('results')
})

test('embedded audio follows quality and cannot become a separate mux track', async () => {
 const r=await start();const internal=r as any
 const audio=(label:string)=>({id:'embedded',label,lang:'未提供',codec:label,isDefault:true,selected:true,embedded:true})
 internal.adoptOptions({qualities:[
  {id:'high',label:'1080p',title:'1080p',width:1080,height:1920,size:10,codec:'H265',drm:'CENC',audios:[audio('AAC')]},
  {id:'low',label:'720p',title:'720p',width:720,height:1280,size:5,codec:'H264',drm:'',audios:[audio('编码未提供')]}
 ],audios:[]},1)
 internal.emit()
 expect(r.snapshot.audios![0].label).toBe('AAC')
 r.handleKey('down')
 expect(r.snapshot.audios![0].label).toBe('编码未提供')
 r.handleKey('tab');r.handleKey(' ');r.handleKey('c')
 expect(r.snapshot.audios![0].selected).toBe(true)
 internal.pending=[{vid:'v1',provider:'hongguo'}];internal.applyOptions()
 expect(internal.pending[0].quality).toBe('low')
 expect(internal.pending[0].height).toBe(720)
 expect(internal.pending[0].audioTracks).toEqual([])
})

test('youku multi-ep applyOptions rebinds probe audio vids onto each episode', async () => {
  const r = await start(); const internal = r as any
  internal.detailProv = 'youku'
  internal.adoptOptions({
    qualities: [{ id: 'cmfv5hd4_dolbyvision_hfr_hbr_hq', label: '帧享', title: 'hq', width: 3840, height: 2160, size: 1, codec: 'H265', drm: 'CENC' }],
    audios: [
      { id: 'EP1|cmfa4hd5_atmos51', label: '杜比全景声', lang: '普通话', codec: 'cmfa4', isDefault: true, selected: true, vid: 'EP1' },
      { id: 'EP1EN|cmfa1hd3', label: 'AAC', lang: '英语', codec: 'cmfa1', isDefault: false, selected: true, vid: 'EP1EN' },
    ],
  }, 2)
  internal.pending = [
    { provider: 'youku', vid: 'EP1', episode: 1, languages: [{ vid: 'EP1', lang: '普通话' }, { vid: 'EP1EN', lang: '英语' }] },
    { provider: 'youku', vid: 'EP2', episode: 2, languages: [{ vid: 'EP2', lang: '普通话' }, { vid: 'EP2EN', lang: '英语' }] },
  ]
  internal.applyOptions()
  expect(internal.pending[0].audioTracks.map((a: { vid: string }) => a.vid)).toEqual(['EP1', 'EP1EN'])
  expect(internal.pending[1].audioTracks.map((a: { vid: string }) => a.vid)).toEqual(['EP2', 'EP2EN'])
  expect(internal.pending[0].audioTracks).not.toBe(internal.pending[1].audioTracks)
})

test('Tencent batch selection retains distinct rendition IDs and personas in every task', async () => {
  const r = await start(); const internal = r as any
  internal.detailProv = 'tencent'
  internal.qualities = [{ id: 'suhd|hard|322157|2741517771455_硬', stream: 'suhd', caption: 'hard', formatId: '322157', persona: '2741517771455_硬', group: 'encode', label: 'HEVC·A', title: 'suhd', width: 3840, height: 1636, size: 1128670539, codec: '4', drm: '' }]
  internal.qIdx = 0; internal.audios = []
  internal.pending = [{ provider: 'tencent', vid: 'one' }, { provider: 'tencent', vid: 'two' }]
  internal.applyOptions()
  expect(internal.pending.map((t: any) => t.tencentQuality)).toEqual([
    { formatId: '322157', persona: '2741517771455_硬', captionProbe: 'hard', group: 'encode', width: 3840, height: 1636 },
    { formatId: '322157', persona: '2741517771455_硬', captionProbe: 'hard', group: 'encode', width: 3840, height: 1636 },
  ])
  expect(internal.pending[0].group).toBe(internal.cfg.releaseGroup)
  expect(internal.pending[0].tencentQuality).not.toBe(internal.pending[1].tencentQuality)
  internal.qualities[0] = { ...internal.qualities[0], id: 'suhd|soft|322093|default_软', formatId: '322093', persona: 'default_软', caption: 'soft' }
  internal.applyOptions()
  expect(internal.pending[0].tencentQuality.formatId).toBe('322093')
  expect(internal.pending[0].caption).toBe('soft')
})


test('Tab cycles platforms on search scene (youku→tencent→hongguo)', async () => {
  const r = await start()
  r.handleKey('f2')
  expect(r.snapshot.scene).toBe('search')
  expect(r.snapshot.providers?.[r.snapshot.providerIndex]).toBe('youku')
  r.handleKey('tab')
  expect(r.snapshot.scene).toBe('search')
  expect(r.snapshot.providers?.[r.snapshot.providerIndex]).toBe('tencent')
  r.handleKey('tab')
  expect(r.snapshot.scene).toBe('search')
  expect(r.snapshot.providers?.[r.snapshot.providerIndex]).toBe('hongguo')
  r.handleKey('tab', { shift: true })
  expect(r.snapshot.scene).toBe('search')
  expect(r.snapshot.providers?.[r.snapshot.providerIndex]).toBe('tencent')
})

test('Ctrl+1/2/3 switches platform like Alt (Windows Terminal friendly)', async () => {
  const r = await start()
  r.handleKey('2', { ctrl: true })
  await Bun.sleep(110)
  expect(r.snapshot.providers?.[r.snapshot.providerIndex]).toBe('tencent')
  expect(r.snapshot.workspace?.provider ?? r.snapshot.providers?.[r.snapshot.providerIndex]).toBe('tencent')
  r.handleKey('3', { ctrl: true })
  await Bun.sleep(110)
  expect(r.snapshot.providers?.[r.snapshot.providerIndex]).toBe('hongguo')
  r.handleKey('1', { ctrl: true })
  await Bun.sleep(110)
  expect(r.snapshot.providers?.[r.snapshot.providerIndex]).toBe('youku')
  // Alt path still works
  r.handleKey('2', { alt: true })
  await Bun.sleep(110)
  expect(r.snapshot.providers?.[r.snapshot.providerIndex]).toBe('tencent')
})

test('settings expose dual QR + cookie + account; Youku QR-only',async()=>{
 const r=await start();const x=r as any
 x.keyInfo={all:true,scope:[]};x.emit()
 expect(x.settingFields().filter((f:string)=>f.startsWith('腾讯'))).toEqual(['腾讯双扫码','腾讯 Cookie','腾讯登录','腾讯 caption=all','腾讯探测原画','腾讯 encode=all','腾讯观测绑定','腾讯诊断日志'])
 expect(x.settingValue('腾讯双扫码')).toContain('App')
 expect(x.settingValue('腾讯登录')).toMatch(/未登录|回车刷新/)
 expect(x.settingFields().filter((f:string)=>f.startsWith('优酷'))).toEqual(['优酷扫码','优酷登录'])
 expect(x.settingValue('优酷扫码')).toContain('仅支持扫码')
})

test('workspace arrows change columns; bare digits switch platform', async () => {
  const r = await start()
  r.handleKey('3', { alt: true })
  await Bun.sleep(150)
  expect(r.snapshot.workspace?.provider).toBe('hongguo')
  expect(r.snapshot.workspace?.focus).toBe('list')
  r.handleKey('right')
  await Bun.sleep(150)
  expect(r.snapshot.workspace?.mode).toBe('rank')
  r.handleKey('right')
  await Bun.sleep(150)
  expect(r.snapshot.workspace?.sectionIndex).toBe(1)
  expect(r.snapshot.workspace?.focus).toBe('list')
  r.handleKey('1')
  await Bun.sleep(150)
  expect(r.snapshot.scene).toBe('workspace')
  expect(r.snapshot.workspace?.provider).toBe('youku')
})

test('reopening filters focuses the active option without applying another filter', async () => {
  const r = await start()
  const discovery = (r as any).discovery
  discovery.section.filters = [{ key: 'genre', title: '体裁', options: [
    { value: 'all', label: '全部' }, { value: 'human', label: '真人' }, { value: 'comic', label: '漫剧' },
  ] }]
  discovery.view.filters = { genre: 'comic' }
  r.handleKey('f')
  expect(r.snapshot.scene).toBe('filters')
  expect(r.snapshot.cursor).toBe(2)
  r.handleKey('up')
  r.handleKey('esc')
  expect(r.snapshot.workspace?.filters).toEqual({ genre: 'comic' })
  r.handleKey('f')
  expect(r.snapshot.cursor).toBe(2)
})

test('shift-right selects a contiguous episode range', async () => {
  const r = await start()
  r.handleKey('enter')
  await Bun.sleep(80)
  r.handleKey('c')
  r.handleKey('right', { shift: true })
  r.handleKey('right', { shift: true })
  const eps = r.snapshot.episodes ?? []
  expect(eps[0]?.selected).toBe(true)
  expect(eps[1]?.selected).toBe(true)
  expect(eps[2]?.selected).toBe(true)
  expect(eps[3]?.selected).toBe(false)
})

test('Tencent collection switching scopes selection and restores tabs after navigation', async () => {
  const r = await start()
  const x = r as any
  const data = { title: '综艺', episode_groups: [{ id: '正片' }, { id: '专访' }], episodes: [
    { vid: 'm1', title: '第1期上', group: '正片', number: 1 },
    { vid: 'm2', title: '第1期下', group: '正片', number: 2 },
    { vid: 'i1', title: '采访', group: '专访', number: 1 },
  ] }
  x.cli.invoke = async () => data
  x.detailProv = 'tencent'
  await x.detail('tencent', 'cover')
  expect(r.snapshot.episodeGroup).toBe('正片')
  r.handleKey('a')
  expect(r.snapshot.episodes!.filter(e => e.selected)).toHaveLength(2)
  r.handleKey(']')
  expect(r.snapshot.episodeGroup).toBe('专访')
  expect(r.snapshot.episodes!.map(e => e.vid)).toEqual(['i1'])
  expect(r.snapshot.episodes!.some(e => e.selected)).toBe(false)
  r.handleKey('f4'); r.handleKey('esc')
  expect(r.snapshot.episodeGroup).toBe('专访')
  expect(r.snapshot.episodeGroups).toEqual(['正片', '专访'])
  await x.detail('tencent', 'cover', 'i1')
  expect(r.snapshot.episodeGroup).toBe('专访')
  expect(r.snapshot.episodes!.find(e => e.vid === 'i1')?.selected).toBe(true)
})

test('new provider settings and single Hami scope are visible without inventing search',async()=>{
 const r=await start();const x=r as any
 x.keyInfo={all:false,scope:['hamivideo']};x.emit()
 expect(x.providers()).toEqual(['hamivideo'])
 expect(x.settingFields()).toContain('Hami Web 准备')
 expect(x.settingFields()).toContain('Hami TV Cookie')
 expect(x.settingFields()).not.toContain('mewatch 激活')
 x.keyInfo={all:true,scope:[]};x.emit()
 expect(x.settingFields()).toContain('mewatch 激活')
 expect(x.settingFields()).toContain('腾讯诊断日志')
})

test('a second-season detail keeps S02 and episode numbers with and without a TMDB match', async () => {
  const r = await start()
  const internal = r as any
  internal.detailProv = 'tencent'
  internal.cli.invoke = async () => ({ title: '大王饶命 第2季', year: 2023,
    episodes: [{ vid: 'season2-ep1', title: '第1集', number: 1 }, { vid: 'season2-ep2', title: '第2集', number: 2 }] })
  await internal.detail('tencent', 'season2')
  r.handleKey('a')
  r.handleKey('enter')
  expect(internal.pending.map((t: any) => [t.series, t.season, t.episode])).toEqual([
    ['大王饶命', 2, 1], ['大王饶命', 2, 2],
  ])
  internal.scene = 'tmdb'
  r.handleKey('s')
  expect(r.snapshot.confirmation?.name).toContain('S02E01')
  expect(r.snapshot.confirmation?.name).not.toContain('第2季')
  internal.scene = 'tmdb'
  internal.tmdbHits = [{ id: 146339, name: '大王饶命', title: '', year: 2021, kind: 'show' }]
  r.handleKey('enter')
  expect(r.snapshot.confirmation?.name).toContain('S02E01')
  expect(internal.pending.every((t: any) => t.tmdbId === 146339 && t.season === 2)).toBe(true)
  expect(folder({ ...internal.pending[0], container: 'mkv' }, '/downloads')).toEndWith('Season 02')
})

test('TMDB movie selection fixes a Tencent detail without category and removes episode naming', async () => {
  const r = await start()
  const internal = r as any
  internal.detailProv = 'tencent'
  internal.cli.invoke = async () => ({ title: '追凶者也', episode_count: 1, episodes: [{ vid: 'q0033rtpdxb', title: '追凶者也', number: '1', kind: '正片' }] })
  await internal.detail('tencent', 'dynsksaef6gmg83')
  r.handleKey('enter')
  expect(r.snapshot.scene).toBe('quality')
  internal.scene = 'tmdb'
  internal.tmdbHits = [{ id: 415634, name: '追凶者也', title: '追凶者也', year: 2016, kind: 'movie' }]
  r.handleKey('enter')
  expect(r.snapshot.scene).toBe('confirm')
  expect(r.snapshot.detail?.kind).toBe('movie')
  expect(r.snapshot.confirmation?.name).toStartWith('追凶者也.2016.')
  expect(r.snapshot.confirmation?.name).not.toContain('S01E01')
  expect(r.snapshot.confirmation?.episodes).toBe('正片')
  const task = internal.pending[0]
  expect(task.kind).toBe('movie')
  expect(task.season).toBe(0)
  expect(task.episode).toBe(0)
  expect(folder(task, '/downloads')).not.toContain('Season ')
  r.handleKey('enter')
  expect(r.snapshot.jobs?.[0]?.title).not.toContain('E01')
})

test('binding a newly added TMDB movie without a release date preserves the platform year in its name and folder', async () => {
  const r = await start()
  const internal = r as any
  internal.detailProv = 'tencent'
  internal.cli.invoke = async () => ({ title: '捉妖天师', year: 2026, category: '电影',
    episodes: [{ vid: 'fixture', title: '捉妖天师', number: '1', kind: '正片' }] })
  await internal.detail('tencent', 'movie')
  r.handleKey('enter')
  internal.scene = 'tmdb'
  internal.tmdbHits = [{ id: 1793262, name: '捉妖天师', title: '捉妖天师', year: 0, kind: 'movie' }]
  r.handleKey('enter')
  expect(r.snapshot.scene).toBe('confirm')
  expect(internal.pending[0].tmdbId).toBe(1793262)
  expect(internal.pending[0].year).toBe(2026)
  expect(r.snapshot.confirmation?.name).toStartWith('捉妖天师.2026.')
  expect(r.snapshot.confirmation?.directory).toEndWith('捉妖天师 (2026) {tmdb-1793262}')
  expect(r.snapshot.confirmation?.name).not.toContain('S01E01')
})

test('manual type switch works without TMDB and returning to TV restores the real episode', async () => {
  const r = await start()
  const internal = r as any
  internal.detailProv = 'tencent'
  internal.cli.invoke = async () => ({ title: '灵境行者', episodes: [{ vid: 'ep5', title: '第05话', number: '5' }] })
  await internal.detail('tencent', 'show')
  r.handleKey('m')
  expect(r.snapshot.detail?.kind).toBe('movie')
  r.handleKey('enter')
  r.handleKey('enter')
  expect(r.snapshot.confirmation?.name).not.toContain('S01E05')
  internal.scene = 'tmdb'
  internal.tmdbHits = [{ id: 123, name: '灵境行者', title: '', year: 2026, kind: 'show' }]
  r.handleKey('enter')
  expect(r.snapshot.detail?.kind).toBe('show')
  expect(r.snapshot.confirmation?.name).toContain('S01E05')
  expect(internal.pending[0].episode).toBe(5)
  expect(internal.pending[0].edition).toBe('')
})

test('switching a movie back to a series preserves an explicit special season zero', async () => {
  const r = await start()
  const internal = r as any
  internal.detailProv = 'tencent'
  internal.cli.invoke = async () => ({ title: '心动的信号', episodes: [{ vid: 'special', title: '雨夜重逢', number: 298, season: 0 }] })
  await internal.detail('tencent', 'show')
  r.handleKey('m')
  r.handleKey('enter')
  r.handleKey('enter')
  internal.scene = 'tmdb'
  internal.tmdbHits = [{ id: 123, name: '心动的信号', title: '', year: 2018, kind: 'show' }]
  r.handleKey('enter')
  expect(internal.pending[0].season).toBe(0)
  expect(r.snapshot.confirmation?.name).toContain('.S00E298.雨夜重逢.')
  expect(r.snapshot.confirmation?.directory).toEndWith('Season 00')
})

test('content type from a search result survives a detail response without category', async () => {
  const r = await start()
  const internal = r as any
  internal.cli.invoke = async () => ({ title: '追凶者也', episodes: [{ vid: 'movie', title: '追凶者也' }] })
  await internal.openRow({ id: 'cid', title: '追凶者也', sub: 'tencent', mediaKind: 'movie' })
  expect(r.snapshot.detail?.kind).toBe('movie')
  r.handleKey('enter')
  r.handleKey('enter')
  expect(r.snapshot.confirmation?.name).not.toContain('S01E01')
  expect(internal.pending[0].edition).toBe('')
})

test('TMDB retry only searches TMDB and a late response cannot reopen a skipped screen', async () => {
  const r = await start()
  const internal = r as any
  r.handleKey('enter')
  for (let i = 0; i < 100 && !(r.snapshot.scene === 'detail' && r.snapshot.episodes?.length); i++) await Bun.sleep(10)
  expect(r.snapshot.episodes!.length).toBeGreaterThan(0)
  r.handleKey('enter')
  for (let i = 0; i < 100 && internal.busy; i++) await Bun.sleep(10)
  expect(internal.busy).toBe(false)
  let calls = 0
  let finish!: (value: unknown) => void
  // Isolate the async work result without mocking modules shared with other tests.
  internal.work = () => { calls++; return new Promise(resolve => { finish = resolve }) }
  internal.cli.invoke = () => { throw new Error('retry must not call Tencent play') }
  internal.scene = 'tmdb'
  r.handleKey('r')
  r.handleKey('r')
  expect(calls).toBe(1)
  r.handleKey('s')
  const status = r.snapshot.status
  finish([{ id: 1, name: 'Late movie', title: '', year: 2026, kind: 'movie' }])
  await Bun.sleep(1)
  expect(r.snapshot.scene).toBe('confirm')
  expect(r.snapshot.status).toBe(status)
  expect(r.snapshot.tmdbHits).toHaveLength(0)
})

test('TMDB proxy settings validate input, hide credentials in summary and can be cleared', async () => {
  const r = await start()
  const internal = r as any
  r.handleKey('f4')
  expect(r.snapshot.settings?.some(s => s.label === 'TMDB 代理')).toBe(true)
  await internal.openSetting('TMDB 代理')
  expect(r.snapshot.scene).toBe('edit')
  await internal.commitEdit('http://user:private-password@localhost:7897/')
  expect(internal.cfg.tmdbProxy).toBe('http://user:private-password@localhost:7897')
  expect(r.snapshot.scene).toBe('settings')
  const summary = r.snapshot.settings?.find(s => s.label === 'TMDB 代理')?.value
  expect(summary).toContain('http://localhost:7897')
  expect(summary).not.toContain('private-password')
  await internal.openSetting('TMDB 代理')
  await internal.commitEdit('socks5://localhost:7897')
  expect(r.snapshot.scene).toBe('edit')
  expect(internal.cfg.tmdbProxy).toBe('http://user:private-password@localhost:7897')
  expect(r.snapshot.status).toContain('HTTP/HTTPS')
  await internal.commitEdit('')
  expect(internal.cfg.tmdbProxy).toBe('')
  expect(r.snapshot.settings?.find(s => s.label === 'TMDB 代理')?.value).toContain('默认网络')
})

test('gateway proxy settings apply to the existing client, validate and mask credentials', async () => {
  const r = await start()
  const internal = r as any
  const client = internal.cli
  let persisted = 0
  internal.persistConfig = () => { persisted++ }
  r.handleKey('f4')
  expect(r.snapshot.settings?.some(s => s.label === '网关代理')).toBe(true)
  await internal.openSetting('网关代理')
  await internal.commitEdit('http://user:private-password@localhost:7897/')
  expect(internal.cfg.gatewayProxy).toBe('http://user:private-password@localhost:7897')
  expect(internal.cli).toBe(client)
  expect(internal.cfg.gatewayProxy).toContain('private-password')
  const summary = r.snapshot.settings?.find(s => s.label === '网关代理')?.value
  expect(summary).not.toContain('private-password')
  expect(internal.cfg.tmdbProxy).toBeUndefined()
  expect(persisted).toBe(1)
  await internal.openSetting('网关代理')
  await internal.commitEdit('http://localhost:7897/proxy.pac')
  expect(r.snapshot.scene).toBe('edit')
  expect(r.snapshot.status).toContain('HTTP/HTTPS')
  expect(internal.cfg.gatewayProxy).toContain('private-password')
  expect(persisted).toBe(1)
  await internal.commitEdit('')
  expect(internal.cfg.gatewayProxy).toBe('')
  expect(persisted).toBe(2)
})

test('settings navigate within groups, reveal full values and return without changing them', async () => {
  const r = await start()
  r.resize(60, 18)
  r.handleKey('f4')
  const current = () => r.snapshot.settings![r.snapshot.cursor]!.label
  expect(current()).toBe('隧道')
  r.handleKey('end')
  expect(current()).toBe('Key')
  r.handleKey('down')
  expect(current()).toBe('Key')
  r.handleKey('right')
  expect(current()).toBe('下载目录')
  const original = r.snapshot.settings![r.snapshot.cursor]!.value
  r.handleKey('i')
  expect(r.snapshot.settingsExpanded).toBe(true)
  r.handleKey('enter')
  expect(r.snapshot.scene).toBe('settings')
  expect(r.snapshot.settings![r.snapshot.cursor]!.value).toBe(original)
  r.handleKey('esc')
  expect(r.snapshot.scene).toBe('settings')
  expect(r.snapshot.settingsExpanded).toBe(false)
  r.handleKey('tab')
  expect(current()).toBe('TMDB Key')
  r.handleKey('left')
  expect(current()).toBe('下载目录')
  r.handleKey('esc')
  expect(r.snapshot.scene).toBe('workspace')
})

test('expanded descriptions scroll independently of selection and collapse on Escape', async () => {
  const r = await start()
  r.resize(60, 18)
  r.handleKey('enter')
  await Bun.sleep(70)
  ;(r as any).detailInfo.desc = '长简介内容，需要保留全部文字。'.repeat(100)
  const cursor = r.snapshot.cursor
  r.handleKey('i')
  r.handleKey('pagedown')
  expect(r.snapshot.contentOffset).toBe(12)
  expect(r.snapshot.cursor).toBe(cursor)
  r.handleKey('end')
  expect(r.snapshot.contentOffset).toBeGreaterThan(12)
  r.handleKey('esc')
  expect(r.snapshot.scene).toBe('detail')
  expect(r.snapshot.detailExpanded).toBe(false)
  expect(r.snapshot.cursor).toBe(cursor)
})

test('confirmation shows the final subdirectory and scrolls long filenames before queueing', async () => {
  const r = await start()
  r.resize(60, 18)
  r.handleKey('enter')
  await Bun.sleep(70)
  r.handleKey('enter')
  ;(r as any).cfg.outDir = join('/Volumes/影音库', ...Array<string>(60).fill('长路径'))
  r.handleKey('enter')
  expect(r.snapshot.scene).toBe('confirm')
  const info = r.snapshot.confirmation!
  expect(info.directory).toStartWith((r as any).cfg.outDir)
  expect(info.directory).toContain('Season 01')
  expect(info.directory).not.toBe((r as any).cfg.outDir)
  expect(info.name).toEndWith('.mkv')
  r.handleKey('pagedown')
  expect(r.snapshot.contentOffset).toBeGreaterThan(0)
  r.handleKey('end')
  const lastOffset = r.snapshot.contentOffset!
  r.handleKey('down')
  expect(r.snapshot.contentOffset).toBe(lastOffset)
  expect(r.snapshot.jobs).toHaveLength(0)
  r.handleKey('esc')
  expect(r.snapshot.scene).toBe('quality')
  r.handleKey('enter')
  expect(r.snapshot.contentOffset).toBe(0)
})

test('PageDown advances one visible grid page and resizing rewraps job details', async () => {
  const r = await start()
  r.resize(60, 18)
  r.handleKey('enter')
  // Wait for the async detail snapshot, instead of assuming a 70ms render deadline.
  for (let i = 0; i < 100 && !(r.snapshot.scene === 'detail' && r.snapshot.episodes?.length); i++) await Bun.sleep(10)
  expect(r.snapshot.episodes!.length).toBeGreaterThan(0)
  const layout = viewMetrics(60, 18)
  const perRow = gridWindow(r.snapshot.episodes!.length, 0, layout.pane.main, 1).perRow
  const expected = Math.min(r.snapshot.episodes!.length - 1, layout.gridRows * perRow)
  r.handleKey('pagedown')
  for (let i = 0; i < 100 && r.snapshot.cursor !== expected; i++) await Bun.sleep(10)
  expect(r.snapshot.cursor).toBe(expected)
  const text = '很长的失败任务说明与保存位置'.repeat(30)
  ;(r as any).jobs = [{ id: 1, title: text, status: '失败', phase: '封装', pct: 0.99, err: text, log: '' }]
  r.handleKey('f3')
  r.handleKey('enter')
  r.resize(140, 40)
  const wideLines = r.snapshot.jobDetailLines!.length
  r.resize(60, 18)
  expect(r.snapshot.jobDetailLines!.length).toBeGreaterThan(wideLines)
  expect(r.snapshot.jobDetailLines!.every(line => displayWidth(line) <= 58)).toBe(true)
  expect(r.snapshot.jobDetailLines!.join('')).toContain(text)
})


test('batch episode titles survive TMDB matching and share preview and download naming', async () => {
  const r = await start()
  const internal = r as any
  const subtitles = ['名场面特辑：狼人有救了！', '加更篇：一起出发']
  internal.cli.invoke = async () => ({ title: '现在就出发 第3季', category: '综艺', episodes: subtitles.map((title, i) => ({ vid: `ep${i + 1}`, title, number: String(i + 1) })) })
  await internal.detail('tencent', 'variety-show')
  r.handleKey('a')
  r.handleKey('enter')
  r.handleKey('enter')
  expect(r.snapshot.confirmation?.name).toContain('.S03E01.名场面特辑.狼人有救了.')
  internal.scene = 'tmdb'
  internal.tmdbHits = [{ id: 123, name: '现在就出发', title: '现在就出发', year: 2026, kind: 'show' }]
  r.handleKey('enter')
  const tasks = internal.pending
  const names = tasks.map((task: any) => filename(jobNaming(task, internal.cfg)))
  expect(names[0]).toContain('现在就出发.S03E01.名场面特辑.狼人有救了.2026.')
  expect(names[1]).toContain('现在就出发.S03E02.加更篇.一起出发.2026.')
  expect(r.snapshot.confirmation?.name).toBe(names[0])
  expect(r.snapshot.confirmation?.directory).toBe(folder(jobNaming(tasks[0], internal.cfg), internal.cfg.outDir))
  r.handleKey('enter')
  expect(r.snapshot.jobs![0]!.title).toContain(subtitles[0]!)
  expect(r.snapshot.jobs![1]!.title).toContain(subtitles[1]!)
})

test('TUI group season selection keeps parent TMDB binding and platform episode numbers, including duplicate S01 choices', async () => {
  const r = await start(), x = r as any
  x.cli.invoke = async () => ({ title: '狐妖小红娘 黄风岭篇', episodes: [
    { vid: 'fox-one', title: '黄风岭篇 第01话', number: 1, season: 13 },
    { vid: 'fox-two', title: '黄风岭篇 第02话', number: 2, season: 13 },
  ] })
  await x.detail('tencent', 'fox')
  x.pending = x.eps.map((_: unknown, i: number) => x.taskFromEp(i))
  x.tmdbHits = [{ id: 75787, name: '狐妖小红娘', year: 2015, title: '', kind: 'show' }]
  x.scene = 'tmdb'; x.emit(); r.handleKey('enter')
  const group = { groupId: '67680070aff5a7d64174fbab', groupName: 'Seasons' }
  const rows = [
    { number: 1, name: '第 1 季', episodeCount: 183, airDate: '2015-06-25' },
    { number: 1, name: '下沙篇', episodeCount: 13, airDate: '2015-06-25', ...group },
    { number: 13, name: '黄风岭篇', episodeCount: 16, airDate: '2026-09-11', ...group },
  ]
  x.work = async () => ({ seasons: rows, warning: '部分剧集分组读取失败' })
  r.handleKey('t'); await Bun.sleep(1)
  expect(r.snapshot.tmdbSeasonPicker?.seasons).toEqual(rows)
  expect(r.snapshot.tmdbSeasonPicker?.warning).toContain('部分剧集分组')
  expect(r.snapshot.tmdbSeasonPicker?.state).toBe('ready')
  r.handleKey('r'); await Bun.sleep(1)
  r.handleKey('end'); r.handleKey('enter')
  expect(x.pending.map((t: any) => [t.tmdbId, t.vid, t.season, t.episode])).toEqual([
    [75787, 'fox-one', 13, 1], [75787, 'fox-two', 13, 2],
  ])
  expect(r.snapshot.confirmation?.directory).toEndWith(join('狐妖小红娘 (2015) {tmdb-75787}', 'Season 13'))
  expect(r.snapshot.confirmation?.name).toContain('狐妖小红娘.S13E01.')
  expect(r.snapshot.confirmation?.name).not.toContain('E168')
  const saved = JSON.parse(JSON.stringify(x.pending[1]))
  expect(completedFilename(jobNaming(saved, x.cfg), { status: 'probed', height: 2160, codec: 'HEVC' })).toContain('.S13E02.')
  r.handleKey('t'); await Bun.sleep(1); r.handleKey('enter')
  expect(x.pending.every((t: any) => t.season === 13)).toBe(true)
})
