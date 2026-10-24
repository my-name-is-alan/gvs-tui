import { describe, expect, test } from 'bun:test'
import { manifestInput, manifestSources, probeManifest, providerLink, requireClearDownload } from './manifest-provider.ts'
import { manifestDetail, normalizeManifestDetail } from './manifest-detail.ts'
import { parseEpisodes } from './episodes.ts'
import { PROVIDER_IDS, supportsBrowse, supportsSearch } from './providers.ts'
import { needsTunnel } from './tunnel-policy.ts'
import type { GwClient } from './client.ts'
import type { FileConfig } from './config.ts'

describe('manifest provider client contracts', () => {
  const media = { url:'https://cdn.example/video.mpd', type:'video', format:'dash', height:2160, headers:{Referer:'https://example.test/',Authorization:'test-session'}, drm:{clear:true} }
  test('both clients share providers, with Hami tunnel but no fabricated search', () => {
    expect(PROVIDER_IDS).toContain('mewatch'); expect(PROVIDER_IDS).toContain('hamivideo')
    expect(needsTunnel(p => p === 'hamivideo')).toBe(true)
    expect(supportsBrowse('hamivideo')).toBe(false); expect(supportsSearch('hamivideo')).toBe(false)
  })
  test('normalized media keeps paired CDN URL and headers', () => {
    const [m] = manifestSources({media:[media]})
    expect(m!.url).toBe(media.url); expect(m!.headers.Authorization).toBe('test-session'); expect(m!.clear).toBe(true)
    expect(() => requireClearDownload(m!)).not.toThrow()
  })
  test('raw and per-media metadata retain DRM boundaries', () => {
    const [m] = manifestSources({media:[{url:media.url,meta:{format:'dash',drm:{system:'widevine',clear:false}}}]})
    expect(m!.drm).toBe('widevine'); expect(() => requireClearDownload(m!)).toThrow('DRM_CLIENT_UNAVAILABLE')
    expect(manifestSources({raw:{media:[media]}})).toHaveLength(1)
  })
  test('unknown DRM and live streams fail before starting download', () => {
    const [unknown] = manifestSources({media:[{...media,drm:{system:'none',encryption:'uninspected'}}]})
    expect(() => requireClearDownload(unknown!)).toThrow()
    const [live] = manifestSources({media:[media],raw:{isLive:true}})
    expect(() => requireClearDownload(live!)).toThrow('直播')
  })
  test('rejects invalid URLs and header line injection', () => {
    expect(manifestSources({media:[{...media,url:'file:///secret'}]})).toHaveLength(0)
    const [m] = manifestSources({media:[{...media,headers:{Good:'value',Bad:'x'+String.fromCharCode(10)+'X: y'}}]})
    expect(m!.headers).toEqual({Good:'value'})
  })
  test('Web and TV route stay separate and qualities do not become dash/hls', async () => {
    expect(manifestInput('hamivideo',{hamiClient:'web'},'OTT_VOD_1')).toEqual({id:'OTT_VOD_1',client:'web',quality:'auto'})
    const calls: unknown[] = []; const cli = {invoke:async (...args:unknown[]) => {calls.push(args);return {media:[media]}}} as unknown as GwClient
    const tv = await probeManifest(cli,{hamiClient:'tv'} as FileConfig,'hamivideo','OTT_VOD_1')
    expect(tv.qualities[0]!.stream).toBe('2160')
    expect(tv.qualities[0]!.tier).toBe(2160)
    const web = await probeManifest(cli,{hamiClient:'web'} as FileConfig,'hamivideo','OTT_VOD_1')
    expect(web.qualities[0]!.stream).toBe('auto'); expect(calls).toHaveLength(2)
  })
  test('resolution tiers stay pixel heights across every manifest row', async () => {
    const cli = {invoke:async () => ({media:[{...media,height:2160},{...media,height:1080},{...media,height:720}]})} as unknown as GwClient
    const result = await probeManifest(cli,{hamiClient:'tv'} as FileConfig,'hamivideo','OTT_VOD_1')
    expect(result.qualities.map(q => q.tier)).toEqual([2160,1080,720])
  })
  test('recognizes exact source domains only', () => {
    expect(providerLink('https://hamivideo.hinet.net/product/1')).toEqual({provider:'hamivideo',url:'https://hamivideo.hinet.net/product/1'})
    expect(providerLink('https://www.mewatch.sg/show/1')?.provider).toBe('mewatch')
    expect(providerLink('https://hamivideo.hinet.net.evil.test/product/1')).toBeUndefined()
    expect(providerLink('https://secret@hamivideo.hinet.net/product/1')).toBeUndefined()
  })
  test('single mewatch movie yields playable item ID, not parent show ID', () => {
    const d = normalizeManifestDetail({id:'movie1',title:'Film',raw:{type:'movie'}})
    expect(parseEpisodes(d)[0]!.vid).toBe('movie1'); expect(d.category).toBe('电影')
  })
  test('collects paginated episodes, deduplicates and preserves season/episode identity', async () => {
    let calls = 0
    const d = await manifestDetail(async (_p,_a,input) => {calls++;return input.cursor ? {episodes:[{id:'b',seasonNumber:2,episodeNumber:4}],hasMore:false} : {title:'Show',episodes:[{id:'a',seasonNumber:1,episodeNumber:3}],hasMore:true,nextCursor:'2'}},'mewatch','show1')
    expect(calls).toBe(2); expect(parseEpisodes(d).map(e => [e.vid,e.season,e.number])).toEqual([['a',1,3],['b',2,4]])
  })
  test('repeating cursor cannot create an infinite request loop', async () => {
    let calls=0; const d = await manifestDetail(async () => {calls++;return {episodes:[{id:'a'}],hasMore:true,nextCursor:'same'}},'mewatch','show1')
    expect(calls).toBe(2); expect(d.hasMore).toBe(true); expect(d.episodes).toHaveLength(1)
  })

  // Crunchyroll：网关 qualities 只读清单不换钥，列表页就能显示真实档位 + 配音 + 字幕。
  test('crunchyroll qualities come from the gateway ladder, not a placeholder', async () => {
    const calls: unknown[] = []
    const cli = {invoke: async (...args: unknown[]) => {
      calls.push(args)
      return {
        qualities: [
          { id: '1080p', label: '1080p', height: 1080, width: 1920, bitrateKbps: 7061, codec: 'avc1.640028', fps: 23.976, stream: '1080p' },
          { id: '720p', label: '720p', height: 720, width: 1280, bitrateKbps: 3317, codec: 'avc1.64001F' },
          { id: '480p', label: '480p', height: 480, width: 854, bitrateKbps: 1573, codec: 'avc1.4D401E' },
        ],
        audioLocale: 'ja-JP',
        audios: [
          { id: 'ja-JP', lang: 'ja-JP', label: '日语', original: true, default: true },
          { id: 'en-US', lang: 'en-US', label: '英语', original: false, default: false },
        ],
        subtitles: [
          { id: 'en-US', lang: 'en-US', label: '英语', format: 'ass', url: 'https://cdn.example/en.ass?t=exp=1' },
          { id: 'zh-Hans', lang: 'zh-Hans', label: '简体中文', format: 'ass', url: 'https://cdn.example/zh.ass?t=exp=1' },
          { id: 'de-DE', lang: 'de-DE', label: '德语', format: 'ass', url: 'https://cdn.example/de.ass?t=exp=1' },
        ],
      }
    }} as unknown as GwClient
    const out = await probeManifest(cli, {} as FileConfig, 'crunchyroll', 'G69P9MD9Y')
    expect((calls[0] as unknown[])[1]).toBe('qualities')
    expect(out.qualities.map(q => q.label)).toEqual(['1080p', '720p', '480p'])
    expect(out.qualities[0]).toMatchObject({ stream: '1080p', tier: 1080, drm: 'widevine', width: 1920 })
    expect(out.qualities[0]!.title).toContain('7061 kbps')
    expect(out.qualities[0]!.fps).toBeCloseTo(23.976, 2)
    // 配音：原声那条标出来，默认选中第一条
    expect(out.audios[0]).toMatchObject({ id: 'ja-JP', lang: 'ja-JP', label: '日语（原声）', selected: true })
    expect(out.audios[1]).toMatchObject({ id: 'en-US', label: '英语', selected: false })
    // 字幕：只有简体中文时勾它，并标为默认显示
    expect(out.subtitles?.map(s => s.id)).toEqual(['en-US', 'zh-Hans', 'de-DE'])
    expect(out.subtitles?.find(s => s.id === 'zh-Hans')).toMatchObject({ selected: true, isDefault: true })
    expect(out.subtitles?.filter(s => s.selected)).toHaveLength(1)
  })

  test('crunchyroll ticks both simplified and traditional Chinese, simplified as default', async () => {
    const cli = {invoke: async () => ({
      qualities: [{ id: '1080p', label: '1080p', height: 1080, width: 1920, bitrateKbps: 7061, codec: 'avc1.640028' }],
      audios: [{ id: 'ja-JP', lang: 'ja-JP', label: '日语', original: true, default: true }],
      subtitles: [
        { id: 'en-US', lang: 'en-US', label: '英语', format: 'ass', url: 'https://cdn.example/en.ass' },
        { id: 'zh-Hant', lang: 'zh-Hant', label: '繁体中文', format: 'ass', url: 'https://cdn.example/zh-hant.ass' },
        { id: 'zh-Hans', lang: 'zh-Hans', label: '简体中文', format: 'ass', url: 'https://cdn.example/zh-hans.ass' },
      ],
    })} as unknown as GwClient
    const out = await probeManifest(cli, {} as FileConfig, 'crunchyroll', 'G69P9MD9Y')
    expect(out.subtitles?.filter(s => s.selected).map(s => s.id)).toEqual(['zh-Hant', 'zh-Hans'])
    expect(out.subtitles?.filter(s => s.isDefault).map(s => s.id)).toEqual(['zh-Hans'])
  })

  test('crunchyroll falls back to English only when the episode has no Chinese subtitles', async () => {
    const cli = {invoke: async () => ({
      qualities: [{ id: '1080p', label: '1080p', height: 1080, width: 1920, bitrateKbps: 7061, codec: 'avc1.640028' }],
      audios: [{ id: 'ja-JP', lang: 'ja-JP', label: '日语', original: true, default: true }],
      subtitles: [
        { id: 'de-DE', lang: 'de-DE', label: '德语', format: 'ass', url: 'https://cdn.example/de.ass' },
        { id: 'en-US', lang: 'en-US', label: '英语', format: 'ass', url: 'https://cdn.example/en.ass' },
      ],
    })} as unknown as GwClient
    const out = await probeManifest(cli, {} as FileConfig, 'crunchyroll', 'G69P9MD9Y')
    expect(out.subtitles?.filter(s => s.selected).map(s => s.id)).toEqual(['en-US'])
    expect(out.subtitles?.find(s => s.id === 'en-US')?.isDefault).toBe(true)
  })

  test('crunchyroll surfaces the stream-limit error instead of an empty ladder', async () => {
    const limit = Object.assign(new Error('该账号同时播放的会话数已达上限'), { errorCode: 'TOO_MANY_QUEUED_STREAMS', httpStatus: 429 })
    const cli = {invoke: async () => { throw limit }} as unknown as GwClient
    await expect(probeManifest(cli, {} as FileConfig, 'crunchyroll', 'G69P9MD9Y')).rejects.toThrow('会话数已达上限')
  })

  test('crunchyroll falls back to the single auto entry on old gateways', async () => {
    const cli = {invoke: async () => { throw new Error('INVALID_PARAM: crunchyroll 支持 …') }} as unknown as GwClient
    const out = await probeManifest(cli, {} as FileConfig, 'crunchyroll', 'G69P9MD9Y')
    expect(out.qualities).toHaveLength(1)
    expect(out.qualities[0]).toMatchObject({ id: 'auto', stream: 'auto', drm: 'widevine' })
    expect(out.audios).toEqual([])
  })
})
