import { expect, test } from 'bun:test'
import { manifestInput, probeManifest, providerLink, resolveManifestDownload } from './manifest-provider'
import { manifestDetail } from './manifest-detail'
import { ProviderSessions } from './provider-session'
import { usesMeasuredNaming } from './completed-naming'
import type { GwClient } from './client'
import type { FileConfig } from './config'

const id = 'umc.cmc.episode'
const keys = [{kid:'1'.repeat(32),key:'2'.repeat(32)}]
const response = {manifest:'#EXTM3U\n',media:[{url:'https://vod-ak-svod.tv.apple.com/master.m3u8',format:'hls',height:1080,drm:{system:'playready',clear:false,contentKeys:keys}}]}

test('Apple TV recognizes exact URLs/IDs and retains the selected codec/HDR rendition', async () => {
  expect(providerLink(id)).toEqual({provider:'appletvplus',url:id})
  expect(providerLink('https://tv.apple.com/jp/show/test/umc.cmc.show')).toMatchObject({provider:'appletvplus'})
  expect(providerLink('https://tv.apple.com.evil.invalid/jp/show/a/umc.cmc.show')).toBeUndefined()
  expect(manifestInput('appletvplus',{},id,'1080|H265|PQ|24')).toEqual({id,quality:'1080|H265|PQ|24'})
  const cli={invoke:async(p:string,a:string,input:Record<string,unknown>)=>{expect(p).toBe('appletvplus');expect(a).toBe('resolve');expect(input).toEqual({id,quality:'1080|H265|PQ|24',download:true});return response}} as unknown as GwClient
  const sources=await resolveManifestDownload(cli,{},'appletvplus',id,'1080|H265|PQ|24')
  expect(sources[0]?.format).toBe('hls');expect(sources[0]?.contentKeys).toEqual([`${'1'.repeat(32)}:${'2'.repeat(32)}`])
  expect(usesMeasuredNaming({provider:'appletvplus'})).toBe(true)
})

test('Apple TV never starts an encrypted download without PlayReady/Widevine keys', async () => {
  for(const drm of [{system:'playready',clear:false},{system:'widevine',clear:false},{system:'fairplay',clear:false,contentKeys:keys}]){
    const cli={invoke:async()=>({...response,media:[{...response.media[0],drm}]})} as unknown as GwClient
    await expect(resolveManifestDownload(cli,{},'appletvplus',id)).rejects.toThrow('DRM_CLIENT_UNAVAILABLE')
  }
})

test('Apple TV accepts content keys from the user Widevine (.wvd) route', async () => {
  const cli={invoke:async()=>({...response,media:[{...response.media[0],drm:{system:'widevine',clear:false,contentKeys:keys}}]})} as unknown as GwClient
  expect((await resolveManifestDownload(cli,{},'appletvplus',id))[0]?.contentKeys).toEqual([`${'1'.repeat(32)}:${'2'.repeat(32)}`])
})

test('Apple TV probes without decrypt requests and preserves all official quality IDs', async () => {
  const cli={invoke:async(_p:string,a:string,input:Record<string,unknown>)=>{expect(a).toBe('probe');expect(input.download).toBeUndefined();return {qualities:[{id:'2160|DV|PQ|24',height:2160,width:3840,codec:'DV',hdr:'PQ',fps:'24',label:'2160p DV PQ'},{id:'1080|H264|SDR|24',height:1080,width:1920,codec:'H264',hdr:'SDR',fps:'24',label:'1080p H264 SDR'}]}}} as unknown as GwClient
  const out=await probeManifest(cli,{} as FileConfig,'appletvplus',id)
  expect(out.qualities.map(q=>q.id)).toEqual(['2160|DV|PQ|24','1080|H264|SDR|24'])
  expect(out.qualities[0]).toMatchObject({height:2160,codec:'DV',drm:'playready',fps:24,size:0,hdr:'PQ'})
  expect(out.qualities[1]).toMatchObject({hdr:'SDR'})
})

test('Apple TV shows an identified size instead of leaving every rendition unknown', async () => {
  const cli={invoke:async()=>({qualities:[
    {id:'2160|DV|PQ|24',height:2160,width:3840,codec:'DV',label:'2160p DV PQ',size:'4000000000'},
    {id:'1080|H265|PQ|24',height:1080,width:1920,codec:'H265',label:'1080p',bitrate:8_000_000,duration:3600},
    {id:'720|H264|SDR|24',height:720,width:1280,codec:'H264',label:'720p',averageBitrate:'2000000'},
    {id:'480|H264|SDR|24',height:480,width:854,codec:'H264',label:'480p',bitrateKbps:1000},
  ]})} as unknown as GwClient
  const out=await probeManifest(cli,{} as FileConfig,'appletvplus',id,1800)
  expect(out.qualities.map(q=>q.size)).toEqual([
    4_000_000_000,
    Math.round(8_000_000 * 3600 / 8),
    Math.round(2_000_000 * 1800 / 8),
    Math.round(1000 * 1000 * 1800 / 8),
  ])
  expect(out.qualities[2]?.title).toContain('估算')
  for (const rate of [undefined, 0, -1, 'invalid', Infinity]) {
    const missing=await probeManifest({invoke:async()=>({qualities:[{id:'2160|H265|SDR|24',height:2160,width:3840,codec:'H265',label:'4K',bitrate:rate}]})} as unknown as GwClient,{} as FileConfig,'appletvplus',id,1800)
    expect(missing.qualities[0]?.size).toBe(0)
  }
})

test('Apple TV preserves complete season/episode identity from gateway detail', async () => {
  const out=await manifestDetail(async(_p,a)=>{expect(a).toBe('detail');return {id:'umc.cmc.show',type:'series',title:'作品',episodesComplete:true,episodes:[{id,vid:id,season:2,number:3,title:'第二季第三集'}]}},'appletvplus','umc.cmc.show')
  expect((out.episodes as Record<string,unknown>[])[0]).toMatchObject({id,season:2,number:3})
})

test('Apple TV imports transient CK, distinguishes verification and restricts official login URLs', async () => {
  const calls:Array<Record<string,unknown>>=[]
  const sessions=new ProviderSessions(async(_p,_a,input)=>{calls.push(input);return input.op==='import'?{state:'imported',authenticated:false,summary:'已导入，待验证'}:input.op==='web'?{state:'awaiting_cookie',url:'https://tv.apple.com/jp'}:{state:'authenticated',authenticated:true}})
  const imported=await sessions.command({provider:'appletvplus',op:'import',cookie:'itua=JP; media-user-token=fixture'})
  expect(imported.authenticated).toBe(false)
  const verified=await sessions.command({provider:'appletvplus',op:'verify',id});expect(verified.authenticated).toBe(true);expect(calls.at(-1)).toEqual({op:'verify',id})
  expect((await sessions.command({provider:'appletvplus',op:'web'})).url).toBe('https://tv.apple.com/jp')
  await expect(sessions.command({provider:'appletvplus',op:'password',username:'x',password:'x'})).rejects.toThrow('不支持')
  const bad=new ProviderSessions(async()=>({state:'awaiting_cookie',url:'https://evil.invalid/'}))
  await expect(bad.command({provider:'appletvplus',op:'web'})).rejects.toThrow('非官方')
})

test('Apple TV probe exposes every audio and subtitle rendition with gateway indexes', async () => {
  const cli = {
    invoke: async (_p: string, a: string) => {
      expect(a).toBe('probe')
      return {
        qualities: [{ id: '1080|H265|PQ|24', height: 1080, width: 1920, codec: 'H265', hdr: 'PQ' }],
        audios: [
          { id: '1', language: 'en', name: 'English', default: true },
          { id: '2', language: 'tr', name: 'Türkçe', default: false },
          { id: '3', language: 'en', name: 'English ', default: true, audioDescription: true },
        ],
        subtitles: [{ id: '1', language: 'zh-Hant', name: '繁體中文', default: false }, { id: '2', language: 'en', name: 'English (CC)', default: false }],
      }
    },
  } as unknown as GwClient
  const out = await probeManifest(cli, {} as FileConfig, 'appletvplus', id)
  expect(out.audios.map(a => [a.id, a.lang, a.selected])).toEqual([['1', 'en', true], ['2', 'tr', false], ['3', 'en', false]])
  expect(out.subtitles?.map(s => [s.id, s.lang])).toEqual([['1', 'zh-Hant'], ['2', 'en']])
})

test('Apple TV download passes the chosen audio/subtitle indexes to resolve', async () => {
  const seen: Record<string, unknown>[] = []
  const cli = {
    invoke: async (_p: string, _a: string, input: Record<string, unknown>) => {
      seen.push(input)
      return response
    },
  } as unknown as GwClient
  await resolveManifestDownload(cli, {}, 'appletvplus', id, '1080|H265|PQ|24', { audio: ['2'], subtitle: ['1', '2'] })
  expect(seen[0]).toMatchObject({ id, download: true, audio: '2', subtitle: '1,2' })
  seen.length = 0
  await resolveManifestDownload(cli, {}, 'appletvplus', id, '1080|H265|PQ|24')
  expect(seen[0]?.audio).toBeUndefined()
  expect(seen[0]?.subtitle).toBeUndefined()
})

test('Crunchyroll requires a local refresh token and hands it to resolve with download', async () => {
  await expect(resolveManifestDownload({ invoke: async () => ({}) } as unknown as GwClient, {}, 'crunchyroll', 'G7PU4MZ1G')).rejects.toThrow('CRUNCHYROLL_TOKEN_REQUIRED')
  const seen: Record<string, unknown>[] = []
  const cli = {
    invoke: async (_p: string, _a: string, input: Record<string, unknown>) => {
      seen.push(input)
      return {
        media: [{
          type: 'video',
          url: 'https://www.crunchyroll.com/playback/v2/manifest/x.mpd',
          format: 'dash',
          headers: { Authorization: 'Bearer short-lived' },
          drm: { system: 'widevine', clear: false, contentKeys: [{ kid: 'a'.repeat(32), key: 'b'.repeat(32) }] },
        }],
      }
    },
  } as unknown as GwClient
  const out = await resolveManifestDownload(cli, { crunchyrollToken: 'rt-value' }, 'crunchyroll', 'G7PU4MZ1G')
  expect(seen[0]).toMatchObject({ id: 'G7PU4MZ1G', download: true, refresh_token: 'rt-value' })
  expect(out[0]).toMatchObject({ format: 'dash', drm: 'widevine', headers: { Authorization: 'Bearer short-lived' } })
  expect(out[0]?.contentKeys).toEqual([`${'a'.repeat(32)}:${'b'.repeat(32)}`])
})

test('Crunchyroll probe reads the ladder through qualities without spending a licence', async () => {
  const calls: string[] = []
  const cli = { invoke: async (_p: string, a: string) => { calls.push(a); return {} } } as unknown as GwClient
  const out = await probeManifest(cli, {} as FileConfig, 'crunchyroll', 'G7PU4MZ1G')
  // qualities 只读 DASH 清单、不换钥：探一次不会产生许可证请求。
  expect(calls).toEqual(['qualities'])
  // 空回包（旧网关 / 没有档位）时退回单条自动档，下载行为不变。
  expect(out.qualities.map(q => q.id)).toEqual(['auto'])
  expect(out.qualities[0]?.drm).toBe('widevine')
})

test('Crunchyroll detail walks series → seasons → episodes for the picker', async () => {
  const calls: Array<{ action: string; input: Record<string, unknown> }> = []
  const invoke = async (_p: string, action: string, input: Record<string, unknown>) => {
    calls.push({ action, input })
    if (action === 'detail') return { id: 'G6VQ0GQ8W', title: '测试番', type: 'series' }
    if (action === 'seasons') return { items: [{ id: 'S1', season_number: 1 }, { id: 'S2', season_number: 2 }] }
    if (action === 'episodes') return { items: input.id === 'S1' ? [{ id: 'EP1', title: '第一集', episode_number: 1 }] : [{ id: 'EP2', title: '第二集', episode_number: 1 }] }
    return {}
  }
  const out = await manifestDetail(invoke as never, 'crunchyroll', 'G6VQ0GQ8W')
  expect(calls.map(c => c.action)).toEqual(['detail', 'seasons', 'episodes', 'episodes'])
  expect(out.type).toBe('series')
  expect((out.episodes as Array<Record<string, unknown>>).map(e => [e.vid, e.season])).toEqual([['EP1', 1], ['EP2', 2]])
})
