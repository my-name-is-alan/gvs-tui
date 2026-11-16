import { expect, test } from 'bun:test'
import type { GwClient } from './client.ts'
import type { FileConfig } from './config.ts'
import { probeOptions } from './quality.ts'
import { userMessage } from './user-message.ts'

const client = (data: Record<string, unknown>) => ({ extra: () => ({}), invoke: async () => data }) as unknown as GwClient

test('Tencent empty catalog preserves network failure as an actionable message', async () => {
  const message = '腾讯取流请求失败，请检查客户端隧道和网络连接。'
  await expect(probeOptions(client({ formats: [], has_url: false, network_error: true, error: 'TV play probes failed' }),
    {} as FileConfig, 'tencent', 'offlinevid01')).rejects.toThrow(message)
  expect(userMessage(new Error(message))).toBe(message)
})

test('Tencent empty catalog reports upstream rejection instead of generic no qualities', async () => {
  const message = '腾讯未返回可用画质（错误码 85）。'
  await expect(probeOptions(client({ formats: [], has_url: false, em: 85, msg: 'unknown' }),
    {} as FileConfig, 'tencent', 'offlinevid01')).rejects.toThrow(message)
  expect(userMessage(new Error(message))).toBe(message)
})

test('a successful partial catalog is still usable and a legacy empty catalog stays empty', async () => {
  const opts = await probeOptions(client({ has_url: true, em: 0, formats: [{ id: 3, name: 'fhd' }] }),
    {} as FileConfig, 'tencent', 'offlinevid01')
  expect(opts.qualities).toHaveLength(1)
  expect((await probeOptions(client({}), {} as FileConfig, 'tencent', 'offlinevid01')).qualities).toEqual([])
})

test('empty successful and malformed responses never expose raw upstream text', async () => {
  for (const data of [{ em: 0, msg: 'ok' }, { em: 'private-token', msg: 'https://example.invalid/private' }]) {
    await expect(probeOptions(client({ ...data, formats: [], has_url: false }), {} as FileConfig,
      'tencent', 'offlinevid01')).rejects.toThrow('腾讯未返回可用画质，请查看客户端诊断日志。')
  }
})
