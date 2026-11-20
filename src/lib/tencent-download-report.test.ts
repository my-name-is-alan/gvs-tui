import { describe, expect, test } from 'bun:test'
import { nextTencentDownloadReport, type TxDownloadReportState } from './tencent-download-report.ts'

function freshState(): TxDownloadReportState {
  return { seq: new Map(), last: new Map() }
}

const seg = (done: number, total: number, bytes?: number) => ({ done, total, bytes })

describe('nextTencentDownloadReport', () => {
  test('ignores non-tencent-shape events and keeps state untouched', () => {
    const s = freshState()
    expect(nextTencentDownloadReport(s, 'v1', '', { err: '' })).toBeNull()
    expect(nextTencentDownloadReport(s, 'v1', '', { err: '', txSegs: seg(0, 0) })).toBeNull()
    expect(nextTencentDownloadReport(s, 'v1', '', { err: '', txSegs: seg(6, 5) })).toBeNull()
    expect(s.seq.size).toBe(0)
    expect(s.last.size).toBe(0)
  })

  test('first progress event reports immediately with seq=1', () => {
    const s = freshState()
    const o = nextTencentDownloadReport(s, 'v1', '', { err: '', txSegs: seg(1, 285, 1024) }, 1000)
    expect(o).toEqual({ vid: 'v1', defn: '', segments: 1, total_segs: 285, bytes: 1024, seq: 1 })
  })

  test('throttles by segment step (max(5, total/20))', () => {
    const s = freshState()
    nextTencentDownloadReport(s, 'v1', '', { err: '', txSegs: seg(1, 285) }, 1000)
    // 1→7 差 6 < 15（ceil(285/20)=15）且 <20s → 节流
    expect(nextTencentDownloadReport(s, 'v1', '', { err: '', txSegs: seg(7, 285) }, 5000)).toBeNull()
    // 1→16 差 15 ≥ step → 发
    const o = nextTencentDownloadReport(s, 'v1', '', { err: '', txSegs: seg(16, 285) }, 6000)
    expect(o?.segments).toBe(16)
    expect(o?.seq).toBe(2)
  })

  test('reports after 20s even when segment step not reached', () => {
    const s = freshState()
    nextTencentDownloadReport(s, 'v1', '', { err: '', txSegs: seg(1, 285) }, 1000)
    const o = nextTencentDownloadReport(s, 'v1', '', { err: '', txSegs: seg(4, 285) }, 21_500)
    expect(o?.segments).toBe(4)
  })

  test('final completion always reports done=total', () => {
    const s = freshState()
    nextTencentDownloadReport(s, 'v1', 'suhd', { err: '', txSegs: seg(10, 285) }, 1000)
    const o = nextTencentDownloadReport(s, 'v1', 'suhd', { done: true, err: '' }, 2000)
    expect(o).toEqual({ vid: 'v1', defn: 'suhd', segments: 285, total_segs: 285, bytes: 0, seq: 2 })
    // 完成后再来一次 complete 不再重复（last.done === total 且无 txSegs 时 final 仍成立会再发？
    // 本实现 final 无条件发；重复 complete 由调用方（onJob 的 before!=='done' 守卫）挡住。
  })

  test('final completion without any prior progress is ignored', () => {
    const s = freshState()
    expect(nextTencentDownloadReport(s, 'v1', '', { done: true, err: '' })).toBeNull()
  })

  test('pause/cancel and failed final events never report', () => {
    const s = freshState()
    nextTencentDownloadReport(s, 'v1', '', { err: '', txSegs: seg(3, 285) }, 1000)
    expect(nextTencentDownloadReport(s, 'v1', '', { done: true, err: '', stopped: 'pause' }, 2000)).toBeNull()
    expect(nextTencentDownloadReport(s, 'v1', '', { done: true, err: 'x', stopped: 'cancel' }, 2000)).toBeNull()
    expect(nextTencentDownloadReport(s, 'v1', '', { done: true, err: 'fail' }, 2000)).toBeNull()
  })

  test('seq increments per vid and state is per vid', () => {
    const s = freshState()
    const a = nextTencentDownloadReport(s, 'a', '', { err: '', txSegs: seg(1, 100) }, 1000)
    const b = nextTencentDownloadReport(s, 'b', '', { err: '', txSegs: seg(1, 100) }, 1000)
    expect(a?.seq).toBe(1)
    expect(b?.seq).toBe(1)
    const a2 = nextTencentDownloadReport(s, 'a', '', { err: '', txSegs: seg(10, 100) }, 1000)
    expect(a2?.seq).toBe(2)
  })
})
