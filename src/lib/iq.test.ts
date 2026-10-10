import { expect, test } from 'bun:test'
import { iqOptions, iqPlan, normalizeIQCookie } from './iq.ts'
import { extractIQLink } from './link.ts'
import { hlsKeyArgs } from './media.ts'
import { PROVIDER_IDS, PROVIDER_LABELS } from './providers.ts'
import { needsTunnel } from './tunnel-policy.ts'
import { resolveDefaultAudioId, selectAudioTracks } from './audio-selection.ts'

test('IQ overseas is a distinct provider and starts its scoped tunnel',()=>{
  expect(PROVIDER_IDS.includes('iq')).toBe(true)
  expect(PROVIDER_LABELS.iq).toBe('IQ 海外版')
  expect(needsTunnel(p=>p==='iq')).toBe(true)
})
test('IQ page matching does not accept domestic pages or lookalike hosts',()=>{
  expect(extractIQLink('分享：https://www.iq.com/album/27mstpb8t4t?lang=zh_cn。')).toBe('https://www.iq.com/album/27mstpb8t4t?lang=zh_cn')
  expect(extractIQLink('iq.com/play/1ewmjgipdkk')).toBe('https://iq.com/play/1ewmjgipdkk')
  for(const text of ['https://www.iqiyi.com/v_123.html','https://iq.com.evil.invalid/album/a','https://u:p@www.iq.com/album/a','https://www.iq.com/account']) expect(extractIQLink(text)).toBe('')
})
test('IQ metadata uses independent default Dolby, not embedded AAC',()=>{
  const result=iqOptions({formats:[{id:'tv:800:hevc',vid:'episode-one-rendition',label:'4K',width:3840,height:1608,codec:'hevc',drm:5}],audios:[{id:'1:1:500',label:'普通话 · 杜比 5.1',lang:'普通话',codec:'eac3',default:true},{id:'1:2:100',label:'普通话 · AAC',lang:'普通话',codec:'aac',default:false}]})
  expect(result.qualities[0]?.stream).toBe('tv:800:hevc')
  expect(result.audios[0]).toMatchObject({codec:'eac3',selected:true,isDefault:true,embedded:false})
  expect(result.audios[1]?.selected).toBe(true)
  expect(result.qualities[0]).toMatchObject({label:'4K',tier:2160,width:3840,height:1608})
})

test('IQ selects every codec of the default language and uses shared automatic and manual defaults', () => {
  const { audios } = iqOptions({ audios: [
    { id: 'aac', label: 'AAC', lang: '普通话', codec: 'aac', default: true },
    { id: 'dolby', label: '杜比 5.1', lang: '普通话', codec: 'eac3' },
    { id: 'dts', label: 'DTS 5.1', lang: '普通话', codec: 'dts' },
  ] })
  const ids = audios.filter(a => a.selected).map(a => a.id)
  expect(ids).toEqual(['aac', 'dolby', 'dts'])
  expect(resolveDefaultAudioId(audios, ids)).toBe('dts')
  expect(selectAudioTracks(audios, ids).map(a => a.isDefault)).toEqual([false, false, true])
  expect(selectAudioTracks(audios, ids, 'aac').map(a => a.isDefault)).toEqual([true, false, false])
  expect(resolveDefaultAudioId(audios, ['aac', 'dolby'])).toBe('dolby')
})

test('IQ Thai original selects Thai codecs without automatically retaining higher-tier Japanese dubbing', () => {
  const { audios } = iqOptions({ audios: [
    { id: 'japanese-dts', lang: '日语', language: 'jpn', codec: 'dts' },
    { id: 'thai-aac', lang: '泰语', language: 'tha', codec: 'aac', default: true },
    { id: 'thai-dolby', lang: 'Thai', language: 'tha', codec: 'eac3' },
    { id: 'japanese-aac', lang: '日语', language: 'jpn', codec: 'aac' },
  ] })
  const ids = audios.filter(a => a.selected).map(a => a.id)
  expect(ids).toEqual(['thai-aac', 'thai-dolby'])
  expect(audios).toHaveLength(4)
  expect(resolveDefaultAudioId(audios, ids)).toBe('thai-dolby')
  expect(selectAudioTracks(audios, ids).map(a => [a.id, a.isDefault])).toEqual([
    ['thai-aac', false], ['thai-dolby', true],
  ])
  // Dubs remain selectable; an explicit default overrides the automatic tier.
  expect(selectAudioTracks(audios, [...ids, 'japanese-aac'], 'japanese-aac').map(a => a.isDefault))
    .toEqual([false, false, true])
})

test('IQ language IDs group codecs even when display names differ', () => {
  const { audios } = iqOptions({ audios: [
    { id: 'source-aac', lang: 'Thai', lid: 157, codec: 'aac', default: true },
    { id: 'source-dolby', lang: '泰语', lid: 157, codec: 'eac3' },
    { id: 'dub', lang: '日语', lid: 158, codec: 'aac' },
  ] })
  expect(audios.filter(a => a.selected).map(a => a.id)).toEqual(['source-aac', 'source-dolby'])
})

test('IQ missing language metadata does not automatically select unrelated dubs', () => {
  const { audios } = iqOptions({ audios: [
    { id: 'unknown', lang: '未提供', codec: 'aac', default: true },
    { id: 'thai', lang: '泰语', codec: 'eac3' },
    { id: 'japanese', lang: '日语', codec: 'dts' },
    { id: '', lang: '泰语', codec: 'aac', default: true },
  ] })
  expect(audios.filter(a => a.selected).map(a => a.id)).toEqual(['unknown'])
  expect(audios).toHaveLength(3)
  const single = iqOptions({ audios: [
    { id: 'thai-aac', language: 'tha', codec: 'aac' },
    { id: 'thai-dolby', language: 'tha', codec: 'eac3' },
  ] })
  expect(single.audios.every(a => a.selected)).toBe(true)
  const ambiguous = iqOptions({ audios: [
    { id: 'first', language: 'tha', codec: 'aac' },
    { id: 'second', language: 'jpn', codec: 'eac3' },
  ] })
  expect(ambiguous.audios.filter(a => a.selected).map(a => a.id)).toEqual(['first'])
})

test('IQ widescreen labels use the resolution tier while retaining actual pixel dimensions',()=>{
  const {qualities}=iqOptions({formats:[{id:'tv:800:hevc',label:'1608P',width:3840,height:1608},{id:'tv:600:hevc',label:'808P',width:1920,height:808}]})
  expect(qualities[0]).toMatchObject({label:'4K',width:3840,height:1608,tier:2160})
  expect(qualities[1]).toMatchObject({label:'1080P',width:1920,height:808,tier:1080})
})
test('IQ protected plans fail rather than use an absent or wrong-format key',()=>{
  const playlist='#EXTM3U\n#EXTINF:4,\nhttps://cdn.iq.com/first.ts\n#EXT-X-ENDLIST\n'
  expect(()=>iqPlan({video:{playlist},drm:{need_decrypt:true}})).toThrow('内容密钥')
  expect(()=>iqPlan({video:{playlist},drm:{content_key_hex:'00'.repeat(16),scheme:'unknown'}})).toThrow('未知解密算法')
  expect(()=>iqPlan({video:{playlist:playlist.replace('#EXT-X-ENDLIST','')},drm:{}})).toThrow('完整点播')
  expect(iqPlan({video:{playlist,vid:'rendition'},drm:{content_key_hex:'01'.repeat(16),scheme:'IQ_BBTS',need_decrypt:true}})).toMatchObject({rendition:'rendition'})
})
test('IQ method is native BBTS, not standard CBC or CENC',()=>{
  expect(hlsKeyArgs('01'.repeat(16),'IQ_BBTS')).toEqual(['--custom-hls-key','01'.repeat(16),'--custom-hls-method','IQ_BBTS','--custom-hls-scope','VIDEO'])
})
test('IQ Netscape cookie import preserves only the IQ domain',()=>{
  expect(normalizeIQCookie('#HttpOnly_.iq.com\tTRUE\t/\tTRUE\t0\tI00001\tOWN\n.evil.invalid\tTRUE\t/\tTRUE\t0\tsecret\tIGNORE')).toBe('I00001=OWN')
  expect(()=>normalizeIQCookie('a=b\r\nInjected: yes')).toThrow()
})
