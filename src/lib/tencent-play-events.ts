/**
 * 腾讯播放会话三事件（起播 dt_video_start / 心跳 dt_video_heartbeat / 完播 dt_video_end）
 * 的节流与观察构建（纯函数，Electron 主进程与终端 TUI 共用）。
 *
 * 语义红线（与网关 mobile42_play_events.go 一致）：
 *   - 三事件值全部来自真实下载生命周期：start=下载开始（位置 0）、heartbeat=当前
 *     已下载时长（位置随进度单调）、end=下载完成（位置=总时长，reason=Normal）
 *     或下载失败（reason=Error）。不虚构观看时长。
 *   - 心跳节流 ≥30s；start/end 每个 vid 每轮只发一次。
 */

export type TxPlayEventState = {
  startSent: boolean
  lastHeartbeatMs: number
  endSent: boolean
}

export type TxPlayEventPhase = 'start' | 'progress' | 'complete' | 'failed'

export type TxPlayEventInput = {
  phase: TxPlayEventPhase
  done: number
  total: number
  durationMs: number
  now: number
}

export type TxPlayObservation = {
  vid: string
  defn: string
  event: 'start' | 'heartbeat' | 'end'
  position_ms: number
  duration_ms: number
  end_reason: number
}

const HEARTBEAT_INTERVAL_MS = 30_000

function positionMs(input: TxPlayEventInput): number {
  if (input.durationMs <= 0 || input.total <= 0) return 0
  const frac = Math.min(1, Math.max(0, input.done / input.total))
  return Math.round(frac * input.durationMs)
}

export function nextTencentPlayEvent(
  state: TxPlayEventState,
  vid: string,
  defn: string,
  input: TxPlayEventInput,
): TxPlayObservation | null {
  switch (input.phase) {
    case 'start':
      if (state.startSent) return null
      state.startSent = true
      return { vid, defn, event: 'start', position_ms: 0, duration_ms: input.durationMs, end_reason: 0 }
    case 'progress': {
      if (!state.startSent || state.endSent) return null
      if (input.now - state.lastHeartbeatMs < HEARTBEAT_INTERVAL_MS) return null
      state.lastHeartbeatMs = input.now
      return { vid, defn, event: 'heartbeat', position_ms: positionMs(input), duration_ms: input.durationMs, end_reason: 0 }
    }
    case 'complete':
    case 'failed': {
      if (state.endSent) return null
      state.endSent = true
      const reason = input.phase === 'failed' ? 1 : 0
      const pos = input.phase === 'failed' ? positionMs(input) : input.durationMs
      return { vid, defn, event: 'end', position_ms: pos, duration_ms: input.durationMs, end_reason: reason }
    }
  }
}
