import { test, expect } from 'bun:test'
import { defaultConfig } from './config.ts'
import { GwClient } from './client.ts'
import { pollTencentQR, tencentPlayInput } from './tencent-qr.ts'
test('Tencent profiles route independently and never send pasted cookie', async () => {
 const cfg = defaultConfig(); cfg.tencentCookie = 'EXISTING'
 const cli = new GwClient('http://localhost','key')
 for (const mode of ['web','app','tv'] as const) {
  cfg.tencentMode = mode
  expect(cli.extra(cfg,'tencent')).toEqual({})
  expect(tencentPlayInput(cfg).session_type).toBe(mode)
  const calls: unknown[]=[]
  await pollTencentQR({invoke:async (...args:unknown[])=>{calls.push(args);return {}}},mode)
  expect(calls).toEqual([['tencent','login',{method:mode==='web'?'qr':mode,session_type:mode,state:'check'}]])
  expect(cfg.tencentCookie).toBe('EXISTING')
 }
 cfg.tencentMode='cookie'
 expect(cli.extra(cfg,'tencent')).toEqual({'Tx-Cookie':'EXISTING'})
 expect(tencentPlayInput(cfg)).toEqual({})
})
