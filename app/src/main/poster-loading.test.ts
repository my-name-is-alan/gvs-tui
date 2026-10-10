import { expect, test } from 'bun:test'
import { createPosterQueue, posterResizeSize } from './poster-loading.ts'

test('a large cover batch cannot exceed six requests and keeps queued work in order', async () => {
  const queue = createPosterQueue(6)
  let active = 0
  let peak = 0
  const starts: number[] = []
  const release: Array<() => void> = []
  const jobs = Array.from({ length: 20 }, (_, i) => queue(async () => {
    starts.push(i)
    active++
    peak = Math.max(peak, active)
    await new Promise<void>(resolve => release.push(resolve))
    active--
    return i
  }))
  expect(starts).toHaveLength(6)
  for (let i = 0; i < 20; i++) {
    release[i]!()
    // Let the completed job hand its permit to exactly one waiter.
    await jobs[i]
  }
  expect(await Promise.all(jobs)).toEqual(Array.from({ length: 20 }, (_, i) => i))
  expect(starts).toEqual(Array.from({ length: 20 }, (_, i) => i))
  expect(peak).toBe(6)
  expect(active).toBe(0)
})

test('failed image requests release their permits and do not block later covers', async () => {
  const queue = createPosterQueue(1)
  let release!: () => void
  const first = queue(async () => {
    await new Promise<void>(resolve => release = resolve)
    throw new Error('connection reset')
  }).catch(error => error.message)
  const second = queue(async () => 'second cover')
  release()
  expect(await first).toBe('connection reset')
  expect(await second).toBe('second cover')
  expect(await queue(async () => 'third cover')).toBe('third cover')
})

test('poster resizing preserves portrait and landscape ratios without enlarging small covers', () => {
  expect(posterResizeSize(3000, 4500, 9 * 1024 * 1024)).toEqual({ width: 640, height: 960 })
  expect(posterResizeSize(3840, 2160, 5 * 1024 * 1024)).toEqual({ width: 640, height: 360 })
  expect(posterResizeSize(1000, 4000, 2 * 1024 * 1024)).toEqual({ width: 320, height: 1280 })
  expect(posterResizeSize(260, 360, 80000)).toBe(null)
  expect(posterResizeSize(260, 360, 800000)).toEqual({ width: 260, height: 360 })
  expect(posterResizeSize(0, 0, 800000)).toBe(null)
})
