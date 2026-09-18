import { expect, test } from 'bun:test'
import { resolveHongguoDownload } from './hongguo.ts'
import { pickHongguo } from './media.ts'
import { probeOptions } from './quality.ts'
import type { GwClient } from './client.ts'
import type { FileConfig } from './config.ts'

const key = '0123456789abcdef0123456789abcdef'
const result = (url = 'https://cdn.test/a', contentKey = key) => ({ videos: { v1: { vid: 'v1', url, key: contentKey } } })

test('download uses the default player and direct key without a separate key call', async () => {
  const calls: unknown[][] = []
  const cli = { invoke: async (...args: Parameters<GwClient['invoke']>) => { calls.push(args); return result() } }
  expect(await resolveHongguoDownload(cli, 'v1')).toEqual({ cdn: 'https://cdn.test/a', key })
  expect(calls).toEqual([['hongguo', 'resolve', { vid: 'v1' }]])
})

test('refreshed resolve returns the new URL and its new key', async () => {
  let calls = 0
  const nextKey = 'a'.repeat(32)
  const cli = { invoke: async () => ++calls === 1 ? result() : result('https://cdn.test/b', nextKey) }
  const first = await resolveHongguoDownload(cli, 'v1')
  const refreshed = await resolveHongguoDownload(cli, 'v1')
  expect(first.key).toBe(key)
  expect(refreshed).toEqual({ cdn: 'https://cdn.test/b', key: nextKey })
})

test('legacy template is still resolved while invalid or missing episodes fail closed', async () => {
  const calls: string[] = []
  const cli = { invoke: async (_: string, action: string): Promise<Record<string, unknown>> => {
    calls.push(action)
    return action === 'key' ? { key } : { videos: { v1: { streams: [{ quality: '1080p', url: 'https://cdn.test/legacy' }], template: 'legacy-envelope' } } }
  } }
  expect(await resolveHongguoDownload(cli, 'v1')).toEqual({ cdn: 'https://cdn.test/legacy', key })
  expect(calls).toEqual(['resolve', 'key'])
  expect(() => pickHongguo(result('https://cdn.test/a', 'bad'), 'v1', '')).toThrow('有效解密密钥')
  expect(pickHongguo(result(), 'different-episode', '').cdn).toBe('')
  expect(pickHongguo({ videos: { v1: {url:'https://cdn.test/a',key,err:'denied'} } }, 'v1', '').cdn).toBe('')
})

test('legacy single URL displays missing metadata honestly', async () => {
  const cli = { invoke: async () => result() } as unknown as GwClient
  const options = await probeOptions(cli, {} as FileConfig, 'hongguo', 'v1')
  expect(options.qualities[0]).toMatchObject({ id:'', label:'默认流', size:0, width:0, height:0, codec:'', drm:'CENC' })
  expect(options.audios[0]).toMatchObject({embedded:true,label:'编码未提供',lang:'未提供'})
})

test('clear media stays clear and failed legacy key resolution is rejected', async () => {
  expect(await resolveHongguoDownload({invoke:async()=>result('https://cdn.test/clear','')},'v1')).toEqual({cdn:'https://cdn.test/clear',key:''})
  await expect(resolveHongguoDownload({invoke:async(_,action)=>action==='key'?{}:{videos:{v1:{url:'https://cdn.test/a',template:'legacy'}}}},'v1')).rejects.toThrow('有效解密密钥')
})


const variants = () => ({videos:{v1:{url:'https://cdn.test/default',key,streams:[
 {id:'1080p|hevc|aac',quality:'1080p',url:'https://cdn.test/high',key,width:1080,height:1920,codec:'hevc',size:12000000,audio:{codec:'aac',profile:'LC',channels:2,sample_rate:48000}},
 {id:'720p|h264|',quality:'720p',url:'https://cdn.test/low',key:'f'.repeat(32),width:720,height:1280,codec:'h264',size:5000000},
 {id:'480p|h264|',quality:'480p',url:'https://cdn.test/clear',key:'',width:480,height:854,codec:'h264'}
]}}})

test('real formats display resolution codec size and embedded audio',async()=>{
 const cli={invoke:async()=>variants()} as unknown as GwClient
 const opts=await probeOptions(cli,{} as FileConfig,'hongguo','v1')
 expect(opts.qualities).toHaveLength(3)
 expect(opts.qualities[0]).toMatchObject({id:'1080p|hevc|aac',label:'1080p',width:1080,height:1920,codec:'H265',size:12000000})
 expect(opts.audios[0]).toMatchObject({label:'AAC LC 2声道 48kHz',lang:'未提供',embedded:true})
 expect(opts.qualities[1].audios![0].label).toBe('编码未提供')
})
test('chosen format keeps its own URL and key on initial and refreshed requests',async()=>{
 let calls=0
 const cli={invoke:async()=>{const data=variants();if(++calls>1){data.videos.v1.streams[1].url='https://cdn.test/new';data.videos.v1.streams[1].key='a'.repeat(32)}return data}}
 expect(await resolveHongguoDownload(cli,'v1','720p|h264|')).toEqual({cdn:'https://cdn.test/low',key:'f'.repeat(32)})
 expect(await resolveHongguoDownload(cli,'v1','720p|h264|')).toEqual({cdn:'https://cdn.test/new',key:'a'.repeat(32)})
 expect(await resolveHongguoDownload(cli,'v1','480p|h264|')).toEqual({cdn:'https://cdn.test/clear',key:''})
 await expect(resolveHongguoDownload(cli,'v1','2160p')).rejects.toThrow('所选红果画质已不可用')
})
