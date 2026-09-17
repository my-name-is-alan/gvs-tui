import { expect, test } from 'bun:test'
import { CdnDenied } from './media.ts'
import { retryCdnRefresh } from './cdn-retry.ts'
import { HlsRefreshError } from './hls-relay.ts'

test('CDN refresh can recover on the sixth attempt with bounded backoff', async () => {
  let calls = 0
  const waits: number[] = [], retries: number[] = []
  const result = await retryCdnRefresh(async () => {
    calls++
    if (calls < 6) throw new CdnDenied(403, '')
    return 'fresh URL succeeded'
  }, (retry, total) => { retries.push(retry); expect(total).toBe(5) }, async ms => { waits.push(ms) })
  expect(result).toBe('fresh URL succeeded')
  expect(calls).toBe(6)
  expect(waits).toEqual([2000, 4000, 8000, 12000, 12000])
  expect(retries).toEqual([1, 2, 3, 4, 5])
})

test('persistent CDN denial stops after five refreshes', async () => {
  let calls = 0, waits = 0
  await expect(retryCdnRefresh(async () => {
    calls++
    throw new CdnDenied(410, '')
  }, undefined, async () => { waits++ })).rejects.toThrow('重试 5 次后 CDN 仍返回 410')
  expect(calls).toBe(6)
  expect(waits).toBe(5)
})

test('non-CDN errors are propagated immediately', async () => {
  let calls = 0
  const failure = new Error('音轨解码失败')
  await expect(retryCdnRefresh(async () => { calls++; throw failure }, undefined,
    async () => { throw new Error('must not wait') })).rejects.toBe(failure)
  expect(calls).toBe(1)
})

test('exhausted in-place refresh never restarts the whole task', async () => {
  let calls = 0
  const failure = new HlsRefreshError('失败分片重新取 CDN 链接 10 次后仍返回 403')
  await expect(retryCdnRefresh(async () => { calls++; throw failure }, undefined,
    async () => { throw new Error('must not restart') })).rejects.toBe(failure)
  expect(calls).toBe(1)
})
