import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import type { ActualVersion, CompletedMedia, GVSActualRecord, MediaSpecs } from './actual-version.ts'
import { readMp4Tracks } from './mp4box.ts'
import { lookMP4Box, tuiBinDir } from './tools.ts'

/** Bounded content sampling survives rename/move and detects many accidental record/file mismatches. */
export function fileFingerprint(path: string): GVSActualRecord['file'] {
  const size = statSync(path).size
  const length = Math.min(65536, size)
  const offsets = [...new Set([0, Math.floor((size - length) / 2), size - length])]
  const hash = createHash('sha256').update(`${size}\n`)
  const fd = openSync(path, 'r')
  try {
    for (const offset of offsets) {
      const bytes = Buffer.alloc(length)
      let count = 0
      while (count < length) {
        const n = readSync(fd, bytes, count, length - count, offset + count)
        if (!n) throw new Error('成品文件在读取期间发生变化')
        count += n
      }
      hash.update(`${offset}\n`).update(bytes)
    }
  } finally { closeSync(fd) }
  return { size, fingerprint: { algorithm: 'sha256-samples-v1', value: hash.digest('hex') } }
}

const positive = (v: unknown): number => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0
const ratio = (v: unknown): number => {
  const [a, b] = String(v || '').split('/').map(Number)
  return a && b ? a / b : 0
}
const trackDuration = (v: unknown): number => {
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(v || ''))
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0
}

export type ProbeAudioOptions = {
  /** Position among the audio tracks that were actually muxed, after any soft skips. */
  muxAudio?: { index: number; count: number }
  /** MP4 tkhd enable flags, independent of FFmpeg's inferred default disposition. */
  enabledAudioTrackIds?: number[]
}

function defaultAudio(streams: Array<Record<string, any>>, options: ProbeAudioOptions): NonNullable<MediaSpecs['audio']> {
  const tracks = streams.filter(s => s.codec_type === 'audio')
  if (!tracks.length) return { status: 'none' }
  if (options.enabledAudioTrackIds?.length === 0) return { status: 'ambiguous' }
  let index = -1, evidence: NonNullable<MediaSpecs['audio']>['evidence']
  if (options.enabledAudioTrackIds !== undefined) {
    const enabled = tracks.map((s, i) => options.enabledAudioTrackIds!.includes(Number(s.id)) ? i : -1).filter(i => i >= 0)
    if (enabled.length === 1 && options.enabledAudioTrackIds.length === 1) { index = enabled[0]!; evidence = 'mp4_enabled' }
  } else {
    const defaults = tracks.map((s, i) => s.disposition?.default === 1 || s.disposition?.default === true ? i : -1).filter(i => i >= 0)
    if (defaults.length === 1) { index = defaults[0]!; evidence = 'container' }
  }
  const mux = options.muxAudio
  if (index < 0 && mux && mux.count === tracks.length && Number.isSafeInteger(mux.index) && mux.index >= 0 && mux.index < tracks.length) {
    index = mux.index; evidence = 'mux_order'
  }
  if (index < 0 && tracks.length === 1 && (options.enabledAudioTrackIds === undefined || options.enabledAudioTrackIds.length === 1)) {
    index = 0; evidence = 'single_track'
  }
  if (index < 0) return { status: 'ambiguous' }
  const audio = tracks[index]!
  const codec = typeof audio.codec_name === 'string' && audio.codec_name !== 'unknown' ? audio.codec_name : undefined
  const channels = positive(audio.channels)
  return { status: 'confirmed', index, evidence, ...(positive(audio.id) ? { trackId: Number(audio.id) } : {}),
    ...(codec ? { codec } : {}), ...(channels ? { channels } : {}),
    ...(/atmos|\bjoc\b/i.test(String(audio.profile || '')) ? { atmos: true } : {}) }
}

export function mediaSpecsFromProbe(payload: string, options: ProbeAudioOptions = {}): MediaSpecs {
  try {
    const data = JSON.parse(payload)
    const v = data.streams?.find((s: Record<string, unknown>) => s.codec_type === 'video' && !(s.disposition as Record<string, unknown>)?.attached_pic)
    if (!v) return { status: 'unavailable' }
    const result: MediaSpecs = { status: 'probed', codec: String(v.codec_name || 'unknown') }
    const fields = {
      width: positive(v.width), height: positive(v.height), fps: ratio(v.avg_frame_rate) || ratio(v.r_frame_rate),
      durationSeconds: positive(v.duration) || trackDuration(v.tags?.DURATION || v.tags?.['DURATION-eng']),
      videoBitrate: positive(v.bit_rate) || positive(v.tags?.BPS) || positive(v.tags?.['BPS-eng']),
    }
    for (const [key, value] of Object.entries(fields)) if (value) (result as Record<string, unknown>)[key] = value
    if (v.side_data_list?.some((s: Record<string, unknown>) => /dovi|dolby vision/i.test(String(s.side_data_type)))) result.dynamicRange = 'DV'
    else if (v.color_transfer === 'smpte2084') result.dynamicRange = 'HDR'
    else if (v.color_transfer === 'arib-std-b67') result.dynamicRange = 'HLG'
    else if (['bt709', 'smpte170m', 'smpte240m', 'bt2020-10', 'bt2020-12', 'iec61966-2-1'].includes(v.color_transfer)) result.dynamicRange = 'SDR'
    result.audio = defaultAudio(data.streams, options)
    return result
  } catch { return { status: 'unavailable' } }
}

/** Optional host ffprobe; no tool download and no decoding of the full video. */
export async function probeFinishedMedia(path: string, signal?: AbortSignal, options: ProbeAudioOptions = {}): Promise<MediaSpecs> {
  const executable = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  const candidate = [tuiBinDir(), ...(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')]
    .map(dir => join(dir, executable)).find(p => { try { return statSync(p).isFile() } catch { return false } })
  if (!candidate) return Promise.resolve({ status: 'unavailable' })
  const payload = await new Promise<string>(resolve => {
    const child = spawn(candidate, ['-v', 'error', '-probesize', '8M', '-analyzeduration', '8000000',
      '-show_streams', '-show_format', '-of', 'json', path], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], signal })
    let output = '', settled = false
    const finish = (payload: string) => { if (!settled) { settled = true; clearTimeout(timer); resolve(payload) } }
    const timer = setTimeout(() => { child.kill(); finish('') }, 15000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      if (output.length > 524288) { child.kill(); finish('') }
    })
    child.once('error', () => finish(''))
    child.once('close', code => finish(code === 0 ? output : ''))
  })
  signal?.throwIfAborted()
  const mp4box = payload && extname(path).toLowerCase() === '.mp4' ? lookMP4Box() : ''
  if (mp4box) {
    try {
      const timeout = AbortSignal.timeout(15000)
      const tracks = (await readMp4Tracks(mp4box, path, signal ? AbortSignal.any([signal, timeout]) : timeout)).filter(t => t.type === 'soun')
      if (tracks.length && tracks.every(t => t.enabled !== undefined)) {
        options = { ...options, enabledAudioTrackIds: tracks.filter(t => t.enabled).map(t => t.id) }
      }
    } catch { signal?.throwIfAborted() /* Fall back to the actual mux mapping or container metadata. */ }
  }
  return mediaSpecsFromProbe(payload, options)
}

export async function finishedVersionRecord(path: string, actual: ActualVersion, signal?: AbortSignal, probed?: MediaSpecs): Promise<GVSActualRecord> {
  const media = probed || await probeFinishedMedia(path, signal)
  signal?.throwIfAborted()
  return { ...actual, file: fileFingerprint(path), media }
}

/** Reuse the naming probe; older queued tasks can read specs without changing their filename. */
export async function finishedMediaRecord(path: string, signal?: AbortSignal, probed?: MediaSpecs,
  probe = probeFinishedMedia): Promise<CompletedMedia> {
  let media = probed
  if (!media) {
    try { media = await probe(path, signal) } catch {
      signal?.throwIfAborted()
      media = { status: 'unavailable' }
    }
  }
  signal?.throwIfAborted()
  return { media, file: { size: statSync(path).size } }
}

/** Shared by desktop and TUI; kept outside all video directories and task-list cleanup. */
export function versionRecordsPath(): string {
  if (process.env.GVS_VERSION_RECORDS_PATH) return process.env.GVS_VERSION_RECORDS_PATH
  const root = process.env.GVS_PROFILE_DIR || (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'GVS')
    : process.platform === 'win32' ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'GVS')
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'GVS'))
  return join(root, 'actual-versions.jsonl')
}

export function saveVersionRecord(output: string, actualVersion: GVSActualRecord, destination = versionRecordsPath()): void {
  mkdirSync(dirname(destination), { recursive: true })
  // One append avoids concurrent completions replacing each other's records. A leading
  // newline also isolates a previous interrupted write; readers skip malformed lines.
  appendFileSync(destination, '\n' + JSON.stringify({ schemaVersion: 1, output, actualVersion }) + '\n', { encoding: 'utf8', mode: 0o600 })
}
