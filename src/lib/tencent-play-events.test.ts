import { describe, expect, test } from 'bun:test'
import { nextTencentPlayEvent, type TxPlayEventState } from './tencent-play-events.ts'

function fresh(): TxPlayEventState {
  return { startSent: false, lastHeartbeatMs: 0, endSent: false }
}

describe('nextTencentPlayEvent', () => {
  test('start fires once with position 0', () => {
    const s = fresh()
    const a = nextTencentPlayEvent(s, 'v1', 'suhd', { phase: 'start', done: 0, total: 285, durationMs: 2825830, now: 1000 })
    expect(a?.event).toBe('start')
    expect(a?.position_ms).toBe(0)
    expect(nextTencentPlayEvent(s, 'v1', '', { phase: 'start', done: 0, total: 285, durationMs: 2825830, now: 2000 })).toBeNull()
  })

  test('heartbeat throttled to 30s with real position', () => {
    const s = fresh()
    nextTencentPlayEvent(s, 'v1', '', { phase: 'start', done: 0, total: 285, durationMs: 2825830, now: 0 })
    // 100/285 ≈ 35% → ~991520ms
    const h1 = nextTencentPlayEvent(s, 'v1', '', { phase: 'progress', done: 100, total: 285, durationMs: 2825830, now: 15_000 })
    expect(h1).toBeNull() // <30s
    const h2 = nextTencentPlayEvent(s, 'v1', '', { phase: 'progress', done: 100, total: 285, durationMs: 2825830, now: 31_000 })
    expect(h2?.event).toBe('heartbeat')
    expect(h2?.position_ms).toBe(Math.round((100 / 285) * 2825830))
    expect(nextTencentPlayEvent(s, 'v1', '', { phase: 'progress', done: 200, total: 285, durationMs: 2825830, now: 45_000 })).toBeNull()
  })

  test('heartbeat never before start or after end', () => {
    const s = fresh()
    expect(nextTencentPlayEvent(s, 'v1', '', { phase: 'progress', done: 5, total: 285, durationMs: 2825830, now: 31_000 })).toBeNull()
    nextTencentPlayEvent(s, 'v1', '', { phase: 'start', done: 0, total: 285, durationMs: 2825830, now: 0 })
    nextTencentPlayEvent(s, 'v1', '', { phase: 'complete', done: 285, total: 285, durationMs: 2825830, now: 1000 })
    expect(nextTencentPlayEvent(s, 'v1', '', { phase: 'progress', done: 200, total: 285, durationMs: 2825830, now: 32_000 })).toBeNull()
  })

  test('complete end is normal with full duration', () => {
    const s = fresh()
    nextTencentPlayEvent(s, 'v1', 'suhd', { phase: 'start', done: 0, total: 285, durationMs: 2825830, now: 0 })
    const e = nextTencentPlayEvent(s, 'v1', 'suhd', { phase: 'complete', done: 285, total: 285, durationMs: 2825830, now: 60_000 })
    expect(e?.event).toBe('end')
    expect(e?.end_reason).toBe(0)
    expect(e?.position_ms).toBe(2825830)
    expect(nextTencentPlayEvent(s, 'v1', '', { phase: 'complete', done: 285, total: 285, durationMs: 2825830, now: 61_000 })).toBeNull()
  })

  test('failed end is reason Error with progress position', () => {
    const s = fresh()
    nextTencentPlayEvent(s, 'v1', '', { phase: 'start', done: 0, total: 285, durationMs: 2825830, now: 0 })
    const e = nextTencentPlayEvent(s, 'v1', '', { phase: 'failed', done: 100, total: 285, durationMs: 2825830, now: 50_000 })
    expect(e?.event).toBe('end')
    expect(e?.end_reason).toBe(1)
    expect(e?.position_ms).toBe(Math.round((100 / 285) * 2825830))
  })
})
