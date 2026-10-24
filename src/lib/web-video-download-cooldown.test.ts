import { expect, test } from 'bun:test'
import { markMgtvBlocked, mgtvBlockedFor } from './web-video-download.ts'

test('mgtv cooldown window blocks the queue for the given span and expires', () => {
  const base = Date.now()
  markMgtvBlocked(60_000)
  expect(mgtvBlockedFor(base + 1_000)).toBeGreaterThan(0)
  expect(mgtvBlockedFor(base + 59_000)).toBeGreaterThan(0)
  expect(mgtvBlockedFor(base + 61_000)).toBe(0)
})
