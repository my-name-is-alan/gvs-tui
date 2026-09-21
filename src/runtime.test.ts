import { test, expect, afterEach } from 'bun:test'
import { Runtime } from './runtime'
import { gridWindow } from './lib/grid'
import { GwClient } from './lib/client'
import { wrapLines, displayWidth } from './lib/text'
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

test('Tencent settings hide device internals and expose App website authorization',async()=>{
 const r=await start();const x=r as any
 x.keyInfo={all:true,scope:[]};x.emit()
 expect(x.settingFields().filter((f:string)=>f.startsWith('腾讯'))).toEqual(['腾讯登录方式','腾讯扫码','腾讯双扫码','腾讯 Cookie'])
 expect(x.settingValue('腾讯双扫码')).toContain('App')
 x.cfg.tencentMode='app'
 expect(x.settingValue('腾讯登录方式')).toContain('网页授权')
 expect(x.settingValue('腾讯扫码')).toContain('回车出码')
})
