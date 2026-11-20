/**
 * 腾讯下载进度上报的节流与观察构建（纯函数，Electron 主进程与终端 TUI 共用）。
 *
 * 语义红线（与网关 mobile42_download_report.go 一致）：
 *   - 只上报真实发生的下载：所有值来自 jobs 层 mobile42 逐段回调
 *     （txSegs.done/total/bytes），不推断、不补造；defn 只在完成事件可用。
 *   - 节流：每 ≥max(5, total/20) 段 或 ≥20s 发一次，成功完成时必发最终事件；
 *     发送由调用方 fire-and-forget，失败只记日志，不阻断下载。
 *   - flowid 由网关从播放会话补齐，这里不发。
 */

export type TxDownloadReportState = {
  /** vid → 下一个事件序号（从 1 递增） */
  seq: Map<string, number>
  /** vid → 最近一次已上报的进度（done/total/bytes + 时间） */
  last: Map<string, { done: number; total: number; bytes: number; at: number }>
}

export type TxDownloadObservation = {
  vid: string
  defn: string
  segments: number
  total_segs: number
  bytes: number
  seq: number
}

export type TxDownloadEvent = {
  done?: boolean
  err: string
  stopped?: string
  txSegs?: { done: number; total: number; bytes?: number }
}

export function nextTencentDownloadReport(
  state: TxDownloadReportState,
  vid: string,
  defn: string,
  e: TxDownloadEvent,
  now = Date.now(),
): TxDownloadObservation | null {
  const last = state.last.get(vid)
  const final = e.done === true && !e.err && !e.stopped && !!last
  if (!e.txSegs && !final) return null
  const total = final ? last!.total : e.txSegs!.total
  const done = final ? last!.total : e.txSegs!.done
  if (total <= 0 || done < 0 || done > total) return null
  const step = Math.max(5, Math.ceil(total / 20))
  if (!final && last && done - last.done < step && now - last.at < 20_000) return null
  const seq = (state.seq.get(vid) ?? 0) + 1
  state.seq.set(vid, seq)
  state.last.set(vid, { done, total, bytes: e.txSegs?.bytes ?? last?.bytes ?? 0, at: now })
  return {
    vid,
    defn,
    segments: done,
    total_segs: total,
    bytes: e.txSegs?.bytes ?? last?.bytes ?? 0,
    seq,
  }
}
