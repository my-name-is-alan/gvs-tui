import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ActualVersion, GVSActualRecord, MediaSpecs } from './actual-version.ts'

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
export function mediaSpecsFromProbe(payload: string): MediaSpecs {
  try {
    const data = JSON.parse(payload)
    const v = data.streams?.find((s: Record<string, unknown>) => s.codec_type === 'video' && !(s.disposition as Record<string, unknown>)?.attached_pic)
    if (!v) return { status: 'unavailable' }
    const result: MediaSpecs = { status: 'probed', codec: String(v.codec_name || 'unknown') }
    const fields = {
      width: positive(v.width), height: positive(v.height), fps: ratio(v.avg_frame_rate) || ratio(v.r_frame_rate),
      durationSeconds: positive(v.duration) || positive(data.format?.duration),
      videoBitrate: positive(v.bit_rate) || positive(v.tags?.BPS) || positive(v.tags?.['BPS-eng']),
    }
    for (const [key, value] of Object.entries(fields)) if (value) (result as Record<string, unknown>)[key] = value
    if (v.side_data_list?.some((s: Record<string, unknown>) => /dovi|dolby vision/i.test(String(s.side_data_type)))) result.dynamicRange = 'DV'
    else if (v.color_transfer === 'smpte2084') result.dynamicRange = 'HDR'
    else if (v.color_transfer === 'arib-std-b67') result.dynamicRange = 'HLG'
    else if (['bt709', 'smpte170m', 'smpte240m', 'bt2020-10', 'bt2020-12', 'iec61966-2-1'].includes(v.color_transfer)) result.dynamicRange = 'SDR'
    return result
  } catch { return { status: 'unavailable' } }
}

/** Optional host ffprobe; no tool download and no decoding of the full video. */
export function probeFinishedMedia(path: string, signal?: AbortSignal): Promise<MediaSpecs> {
  const executable = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  const candidate = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')
    .map(dir => join(dir, executable)).find(p => { try { return statSync(p).isFile() } catch { return false } })
  if (!candidate) return Promise.resolve({ status: 'unavailable' })
  return new Promise(resolve => {
    const child = spawn(candidate, ['-v', 'error', '-probesize', '8M', '-analyzeduration', '8000000',
      '-show_streams', '-show_format', '-of', 'json', path], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], signal })
    let output = '', settled = false
    const finish = (specs: MediaSpecs) => { if (!settled) { settled = true; clearTimeout(timer); resolve(specs) } }
    const timer = setTimeout(() => { child.kill(); finish({ status: 'unavailable' }) }, 15000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      if (output.length > 524288) { child.kill(); finish({ status: 'unavailable' }) }
    })
    child.once('error', () => finish({ status: 'unavailable' }))
    child.once('close', code => finish(code === 0 ? mediaSpecsFromProbe(output) : { status: 'unavailable' }))
  })
}

export async function finishedVersionRecord(path: string, actual: ActualVersion, signal?: AbortSignal): Promise<GVSActualRecord> {
  const media = await probeFinishedMedia(path, signal)
  signal?.throwIfAborted()
  return { ...actual, file: fileFingerprint(path), media }
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
