import { spawn } from 'node:child_process'

export type TrackTiming = {
  id: number
  type: string
  packets: number
  firstMs: number
  endMs: number
  maxGapMs: number
  maxOverlapMs: number
}

/** Parse packet PTS, not DTS or the container's advertised duration. */
export function frameCrcTiming() {
  const tracks = new Map<number, TrackTiming & { scale: number; previousEnd?: number }>()
  let tail = ''
  const line = (value: string) => {
    const tb = /^#tb (\d+): (\d+)\/(\d+)/.exec(value)
    if (tb) {
      tracks.set(Number(tb[1]), { id: Number(tb[1]), type: '', scale: 1000 * Number(tb[2]) / Number(tb[3]),
        packets: 0, firstMs: Infinity, endMs: -Infinity, maxGapMs: 0, maxOverlapMs: 0 })
      return
    }
    const type = /^#media_type (\d+): (\w+)/.exec(value)
    if (type) { const t = tracks.get(Number(type[1])); if (t) t.type = type[2]!; return }
    if (!/^\d+,/.test(value)) return
    const fields = value.split(',')
    const track = tracks.get(Number(fields[0]))
    if (!track) throw new Error('缺少轨道时基')
    const pts = Number(fields[2]) * track.scale
    const duration = Number(fields[3]) * track.scale
    if (!Number.isFinite(pts) || !Number.isFinite(duration) || duration < 0) throw new Error('媒体时间戳无效')
    if (track.type === 'audio' && track.previousEnd !== undefined) {
      track.maxGapMs = Math.max(track.maxGapMs, pts - track.previousEnd)
      track.maxOverlapMs = Math.max(track.maxOverlapMs, track.previousEnd - pts)
    }
    track.packets++
    track.firstMs = Math.min(track.firstMs, pts)
    track.endMs = Math.max(track.endMs, pts + duration)
    track.previousEnd = pts + duration
  }
  return {
    feed(chunk: string) {
      const lines = (tail + chunk).split(/\r?\n/)
      tail = lines.pop() ?? ''
      lines.forEach(line)
    },
    finish(): TrackTiming[] {
      if (tail.trim()) line(tail)
      return [...tracks.values()].map(({ scale, previousEnd, ...t }) => t)
    },
  }
}

/** Read packet presentation time after MP4 edit lists/composition offsets.
 * A small reorder window is needed because the first decoded video packet
 * need not have the earliest PTS. Missing timestamps are an error, never zero.
 */
export async function firstPresentationMs(ffmpeg: string, path: string, stream: string): Promise<number> {
  if (!/^[va]:\d+$/.test(stream)) throw new Error('无效媒体轨道选择')
  return new Promise((resolve, reject) => {
    const parser = frameCrcTiming()
    const child = spawn(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-copyts', '-i', path,
      '-map', `0:${stream}`, '-c', 'copy', '-frames:0', '64', '-avoid_negative_ts', 'disabled', '-f', 'framecrc', 'pipe:1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let errors = '', parseError: unknown
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      try { parser.feed(chunk) } catch (e) { parseError = e; child.kill() }
    })
    child.stderr.on('data', (b: Buffer) => { errors = (errors + b.toString()).slice(-4000) })
    child.once('error', reject)
    child.once('close', (code) => {
      try {
        if (parseError) throw parseError
        if (code !== 0 || errors.trim()) throw new Error(`读取原始时间戳失败 (${code}) ${stream} ${path}: ${errors.trim()}`)
        const track = parser.finish()[0]
        if (!track?.packets || !Number.isFinite(track.firstMs)) throw new Error('轨道没有有效的呈现时间戳')
        resolve(track.firstMs)
      } catch (e) { reject(e) }
    })
  })
}

/** All streams share one origin; audio that starts earlier delays the video.
 * Never clamp each track independently, which would destroy relative timing.
 */
export function relativePresentationStarts(videoMs: number, audioMs: number[], delays: number[]): number[] {
  if (audioMs.length !== delays.length) throw new Error('音轨偏移数量不匹配')
  const starts = [videoMs, ...audioMs.map((v, i) => v + delays[i]!)]
  if (starts.some(v => !Number.isFinite(v))) throw new Error('无法确定音视频相对起点')
  const origin = Math.min(...starts)
  return starts.map(v => v - origin)
}

/** Uses bundled ffmpeg, without decoding/re-encoding or depending on ffprobe. */
export async function inspectMediaTiming(ffmpeg: string, path: string): Promise<TrackTiming[]> {
  return new Promise((resolve, reject) => {
    const parser = frameCrcTiming()
    const child = spawn(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-copyts', '-i', path,
      '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-avoid_negative_ts', 'disabled', '-f', 'framecrc', 'pipe:1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let errors = ''
    let parseError: unknown
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      try { parser.feed(chunk) } catch (e) { parseError = e; child.kill() }
    })
    child.stderr.on('data', (b: Buffer) => { errors = (errors + b.toString()).slice(-4000) })
    child.once('error', reject)
    child.once('close', (code) => {
      try {
        if (parseError) throw parseError
        // FFmpeg may return 0 even after "File ended prematurely".
        if (code !== 0 || errors.trim()) throw new Error(`媒体包校验失败 (${code}): ${errors.trim()}`)
        const tracks = parser.finish()
        if (!tracks.length || tracks.some(t => !t.packets)) throw new Error('媒体轨道为空')
        resolve(tracks)
      } catch (e) { reject(e) }
    })
  })
}

export function assertAudioContinuity(tracks: TrackTiming[]): void {
  if (!tracks.some(t => t.type === 'audio')) throw new Error('没有音轨')
  for (const t of tracks.filter(t => t.type === 'audio')) {
    if (t.maxGapMs > 100 || t.maxOverlapMs > 100) {
      throw new Error(`音轨 ${t.id} 时间戳不连续：空洞 ${t.maxGapMs.toFixed(1)}ms，重叠 ${t.maxOverlapMs.toFixed(1)}ms`)
    }
  }
}

export function assertMediaDuration(tracks: TrackTiming[], expectedMs: number): void {
  if (!Number.isFinite(expectedMs) || expectedMs <= 0) throw new Error('无法确认媒体预期时长')
  const end = Math.max(...tracks.map(t => t.endMs))
  if (!Number.isFinite(end) || Math.abs(end - expectedMs) > 2000) {
    throw new Error(`实际媒体结束于 ${(end / 1000).toFixed(3)}s，预期 ${(expectedMs / 1000).toFixed(3)}s`)
  }
}
