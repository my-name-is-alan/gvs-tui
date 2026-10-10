import { inspectMediaTiming, type TrackTiming } from './media-timing.ts'
import { spawn } from 'node:child_process'
import type { TencentQualitySelection } from '../types.ts'

export type TencentSpecs = { width: number; height: number; fps: number; hdr: boolean }
export function tencentSpecsFromFFmpeg(text: string): TencentSpecs | null {
  const lines = text.split(/\r?\n/)
  const index = lines.findIndex(s => /^\s*Stream #0:\d+.*: Video:/.test(s))
  const line = lines[index]
  const dims = line?.match(/\b(\d{2,5})x(\d{2,5})\b/)
  if (!line || !dims) return null
  const next = lines.findIndex((s, i) => i > index && /^\s*Stream #/.test(s))
  const video = lines.slice(index, next < 0 ? undefined : next).join('\n')
  const sideData = video.split(/\n[ \t]*Side data:[ \t]*\n/)[1] || ''
  return { width: Number(dims[1]), height: Number(dims[2]),
    fps: Number(line.match(/([\d.]+) fps\b/)?.[1]) || 0,
    // Main 10 / 10-bit pixels also occur in SDR; require video HDR signaling.
    hdr: /\b(?:smpte2084|arib-std-b67)\b/i.test(line) || /\b(?:dovi|dolby vision)\b/i.test(sideData) }
}

/** Resolution and fps mismatches fail; catalog HDR differences remain a completion warning. */
export function assertTencentSpecs(actual: TencentSpecs | null, selected: TencentQualitySelection, fallbackHeight = 0): string {
  if (!actual) throw new Error('腾讯实际视频规格无法确认，未生成成品')
  const width = selected.width || 0, height = selected.height || 0
  const long = Math.max(actual.width, actual.height), short = Math.min(actual.width, actual.height)
  // Batch selections can come from a landscape episode while extras are portrait.
  // Compare both ordered edges so rotation passes but a lower resolution does not.
  const tooSmall = width && height
    ? long + 16 < Math.max(width, height) || short + 16 < Math.min(width, height)
    : width ? long + 16 < width : height ? short + 16 < height
    // Legacy queues store a tier; use the long edge for cropped films and portrait clips.
    : fallbackHeight > 0 ? long + 16 < Math.floor(fallbackHeight * 16 / 9) : false
  const reasons: string[] = []
  if (tooSmall) reasons.push(`分辨率实际 ${actual.width}×${actual.height}，要求 ${width && height ? `${width}×${height}` : width ? `长边 ${width}` : height ? `短边 ${height}` : `${fallbackHeight}p`}`)
  if (selected.fps && actual.fps + 2 < selected.fps) reasons.push(`帧率实际 ${actual.fps}fps，要求 ${selected.fps}fps`)
  if (reasons.length) throw new Error(`腾讯返回视频与所选画质不符：${reasons.join('；')}；已停止，未生成成品`)
  return selected.hdr && selected.hdr.toLowerCase() !== 'sdr' && !actual.hdr
    ? `所选 ${selected.hdr.toUpperCase()} 未在实际视频中确认，已保留下载结果，文件名按实际规格生成` : ''
}

export async function verifyTencentSpecs(ffmpeg: string, path: string, selected: TencentQualitySelection, fallbackHeight = 0, signal?: AbortSignal): Promise<TencentSpecs & { note?: string }> {
  const specs = await new Promise<TencentSpecs | null>((resolve, reject) => {
    const child = spawn(ffmpeg, ['-nostdin', '-hide_banner', '-i', path], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal })
    let output = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('腾讯规格检查超时')) }, 15000)
    child.stderr.on('data', (b: Buffer) => { output = (output + b.toString()).slice(-262144) })
    child.once('error', e => { clearTimeout(timer); reject(e) })
    child.once('close', () => { clearTimeout(timer); signal?.aborted ? reject(signal.reason) : resolve(tencentSpecsFromFFmpeg(output)) })
  })
  const note = assertTencentSpecs(specs, selected, fallbackHeight)
  return { ...specs!, ...(note ? { note } : {}) }
}

/** Packet coverage, rather than MKV duration (which may come from a longer audio track). */
export function assertTencentCoverage(tracks: TrackTiming[], expectedSeconds = 0): void {
  const videos = tracks.filter(t => t.type === 'video')
  if (videos.length !== 1 || !videos[0]!.packets) throw new Error('腾讯视频轨为空或无法确认，未生成成品')
  const span = (t: TrackTiming) => (t.endMs - t.firstMs) / 1000
  const video = span(videos[0]!)
  if (!Number.isFinite(video) || video <= 0) throw new Error('腾讯视频时长无效，未生成成品')
  const compare = (reference: number, label: string) => {
    if (!Number.isFinite(reference) || reference <= 0) return
    const tolerance = Math.max(10, reference * 0.03)
    if (Math.abs(video - reference) > tolerance)
      throw new Error(`腾讯视频不完整：视频 ${video.toFixed(2)} 秒，${label} ${reference.toFixed(2)} 秒；可能返回试看或截断流，未生成成品`)
  }
  compare(expectedSeconds, '分集预期')
  for (const audio of tracks.filter(t => t.type === 'audio')) compare(span(audio), `音轨 ${audio.id}`)
}

export async function verifyTencentCoverage(ffmpeg: string, path: string, expectedSeconds = 0, signal?: AbortSignal): Promise<number> {
  const tracks = await inspectMediaTiming(ffmpeg, path, signal)
  assertTencentCoverage(tracks, expectedSeconds)
  const video = tracks.find(t => t.type === 'video')!
  return (video.endMs - video.firstMs) / 1000
}
