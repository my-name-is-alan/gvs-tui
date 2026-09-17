import { expect, test } from 'bun:test'
import { fetchToolBytes } from './tool-download.ts'

test('tool download retries connection and response-body failures', async () => {
  let calls = 0
  const waits: number[] = []
  const fetcher = (async () => {
    calls++
    if (calls === 1) throw new Error('The socket connection was closed unexpectedly')
    if (calls === 2) return new Response(new ReadableStream({ start(c) { c.error(new Error('body connection reset')) } }))
    if (calls === 3) return new Response('bad', { status: 503 })
    return new Response('complete archive')
  })
  expect((await fetchToolBytes('https://example.test/tool.zip', { label: 'ffmpeg', fetcher, wait: async ms => { waits.push(ms) } })).toString()).toBe('complete archive')
  expect(calls).toBe(4)
  expect(waits).toEqual([1000, 2000, 4000])
})

test('tool download does not accept a truncated archive', async () => {
  let calls = 0
  const fetcher = (async () => {
    calls++
    return calls === 1 ? new Response('abc', { headers: { 'content-length': '20' } }) : new Response('fixed')
  })
  expect((await fetchToolBytes('https://example.test/tool.zip', { label: 'RE', fetcher, wait: async () => {} })).toString()).toBe('fixed')
  expect(calls).toBe(2)
})

test('permanent HTTP failure and cancellation do not repeat downloads', async () => {
  let calls = 0
  const fetcher = async () => { calls++; return new Response('', { status: 404 }) }
  await expect(fetchToolBytes('https://example.test/tool.zip', { label: 'packager', fetcher })).rejects.toThrow('packager 下载失败：HTTP 404')
  expect(calls).toBe(1)
  await expect(fetchToolBytes('https://example.test/tool.zip', { label: 'packager', fetcher, signal: AbortSignal.abort() })).rejects.toThrow('已取消')
  expect(calls).toBe(1)
})
