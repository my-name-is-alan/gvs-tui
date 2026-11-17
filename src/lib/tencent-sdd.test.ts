import { expect, test } from 'bun:test'
import { tencentCipher } from './jobs.ts'
import { sourceIdentity } from './media.ts'

test('Tencent inner SDD is mandatory and becomes distinct resume material', () => {
  const outer = {enc:1,method:'CHACHA20_V3',content_key_hex:'ab'.repeat(32),iv_hex:'31'.repeat(12)}
  const sdd = {required:true,cipher_type:'chacha20_v2',pattern:'A584C2CB45653B85',content_key_hex:'cd'.repeat(32),iv_hex:'32'.repeat(12)}
  const cipher = tencentCipher({drm:{...outer,method:'CHACHA20_V3_SDD',sdd}})!
  expect(cipher.key).toBe('ab'.repeat(32)+'cd'.repeat(32)+'32'.repeat(12))
  expect(sourceIdentity('https://example.invalid/stream',cipher)).not.toBe(sourceIdentity('https://example.invalid/stream',tencentCipher({drm:outer})))
  expect(() => tencentCipher({drm:{...outer,sdd}})).toThrow('内层解密方式缺失')
  for (const broken of [undefined,{...sdd,pattern:'unknown'},{...sdd,iv_hex:'00'},{...sdd,required:false}]) {
    expect(() => tencentCipher({drm:{...outer,method:'CHACHA20_V3_SDD',sdd:broken}})).toThrow('SDD')
  }
})
