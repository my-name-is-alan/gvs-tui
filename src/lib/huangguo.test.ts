import { expect, test } from 'bun:test'
import { resolveHuangguoDownload, pickHuangguo, huangguoStreamOptions } from './huangguo.ts'
import { probeOptions } from './quality.ts'
import { hlsKeyArgs, referer } from './media.ts'
import type { GwClient } from './client.ts'
import type { FileConfig } from './config.ts'

const key = '0123456789abcdef0123456789abcdef'
const AI = 'huangguoai:117:ep-1'

/** 网关 resolve 的形状：media[0] 是选好的档位，variants[] 是全档位。 */
const result = (url = 'https://cdn.test/720/index.m3u8', contentKey = key) => ({
  id: AI,
  source: 'huangguoai',
  media: [
    {
      type: 'video',
      url,
      quality: '720p',
      width: 720,
      height: 1280,
      headers: { Referer: 'https://huangguoai.com/', 'User-Agent': 'UA' },
    },
  ],
  master: 'https://cdn.test/master.m3u8',
  variants: [
    { url: 'https://cdn.test/1080/index.m3u8', quality: '1080p', width: 1080, height: 1920, bandwidth: 5_000_000 },
    { url: 'https://cdn.test/720/index.m3u8', quality: '720p', width: 720, height: 1280, bandwidth: 2_500_000 },
    { url: 'https://cdn.test/480/index.m3u8', quality: '480p', width: 480, height: 854, bandwidth: 800_000 },
  ],
  key: contentKey ? { method: 'AES-128', hex: contentKey, bits: 128 } : undefined,
})

test('download uses the gateway URL and its paired AES key', async () => {
  const calls: unknown[][] = []
  const cli = {
    invoke: async (...args: Parameters<GwClient['invoke']>) => {
      calls.push(args)
      return result()
    },
  }
  expect(await resolveHuangguoDownload(cli, AI)).toEqual({
    url: 'https://cdn.test/720/index.m3u8',
    key,
    headers: { Referer: 'https://huangguoai.com/', 'User-Agent': 'UA' },
  })
  expect(calls).toEqual([['huangguo', 'resolve', { id: AI }]])
})

test('chosen quality is requested from the gateway and never silently downgraded', async () => {
  const seen: Array<Record<string, unknown>> = []
  const cli = {
    invoke: async (_p: string, _a: string, input: Record<string, unknown>) => {
      seen.push(input)
      const quality = String(input.quality ?? '')
      const data = result(`https://cdn.test/${quality || '720'}/index.m3u8`)
      data.media[0].quality = quality || '720p'
      return data
    },
  }
  expect((await resolveHuangguoDownload(cli, AI, '1080p')).url).toBe('https://cdn.test/1080p/index.m3u8')
  expect(seen[0]).toEqual({ id: AI, quality: '1080p' })
  // 网关没有这一档时：报错，而不是拿 720p 顶替。
  const only = { ...result('https://cdn.test/720/index.m3u8') }
  only.variants = only.variants.filter((v) => v.quality !== '2160p')
  only.media = [{ ...only.media[0], quality: '720p' }]
  await expect(
    resolveHuangguoDownload({ invoke: async () => only }, AI, '2160p'),
  ).rejects.toThrow('所选黄果画质已不可用')
})

test('clear media stays clear and an invalid key fails closed', async () => {
  const clear = result('https://cdn.test/a.m3u8', '')
  expect((await resolveHuangguoDownload({ invoke: async () => clear }, AI)).key).toBe('')
  const bad = result()
  bad.key = { method: 'AES-128', hex: 'not-a-key', bits: 128 }
  expect(() => pickHuangguo(bad)).toThrow('有效解密密钥')
})

test('a listed variant cannot reuse the selected media key', () => {
  expect(() => pickHuangguo(result(), '1080p')).toThrow('所选黄果画质已不可用')
  expect(pickHuangguo(result(), '720p').url).toBe('https://cdn.test/720/index.m3u8')
})

test('missing media reports the gateway reason instead of a URL', async () => {
  const cli = { invoke: async () => ({ error: '上游未返回无效播放列表' }) } as unknown as GwClient
  await expect(resolveHuangguoDownload(cli, AI)).rejects.toThrow('黄果: 上游未返回无效播放列表')
})

test('quality list comes from the master variants and says the audio rides the video stream', async () => {
  const cli = { invoke: async () => result() } as unknown as GwClient
  const options = await probeOptions(cli, {} as FileConfig, 'huangguo', AI)
  expect(options.qualities.map((q) => q.label)).toEqual(['1080p', '720p', '480p'])
  expect(options.qualities[0]).toMatchObject({ label: '1080p', width: 1080, height: 1920, drm: 'AES-128' })
  expect(options.audios[0]).toMatchObject({ embedded: true, lang: '未提供', selected: true })
})

test('a gateway without variants still yields one honest default row', () => {
  const data = result()
  delete (data as Record<string, unknown>).variants
  const { qualities, audios } = huangguoStreamOptions(data)
  expect(qualities).toHaveLength(1)
  expect(qualities[0]).toMatchObject({ id: '', label: '默认流', size: 0, width: 0, height: 0, drm: 'AES-128' })
  expect(audios[0].embedded).toBe(true)
})

test('AES-128 key args do not ask for the CENC decoder', () => {
  expect(hlsKeyArgs(key, 'AES_128')).toEqual(['--custom-hls-key', key, '--custom-hls-method', 'AES_128'])
  // 优酷仍走 CENC 默认值，行为不变。
  expect(hlsKeyArgs(`${'a'.repeat(32)}:${key}`)).toContain('CENC')
})

test('huangguo referer is only a fallback for gateway headers', () => {
  expect(referer('huangguo')).toBe('https://huangguoai.com/')
})
