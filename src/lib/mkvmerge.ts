import { spawn } from 'node:child_process'
import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { truncate } from './util.ts'
import { ensureFFmpeg } from './tools.ts'
import { firstPresentationMs, relativePresentationStarts } from './media-timing.ts'

type Phase = { out: string; inputs?: string[]; cb?: (n: number, total: number) => void }

function sizes(paths: string[] | undefined): number {
  let n = 0
  for (const p of paths ?? []) {
    try { n += statSync(p).size } catch { /* not written yet */ }
  }
  return n
}

function watchOutput(phase?: Phase): () => void {
  if (!phase?.cb) return () => {}
  const timer = setInterval(() => {
    try { phase.cb?.(statSync(phase.out).size, Math.max(1, sizes(phase.inputs))) }
    catch { /* 输出还没建出来 */ }
  }, 250)
  return () => clearInterval(timer)
}

function run(bin: string, args: string[], phase?: Phase): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const stop = watchOutput(phase)
  const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d: Buffer) => { out += d.toString() })
  child.stderr.on('data', (d: Buffer) => { out += d.toString() })
  child.on('error', (e) => { stop(); reject(e) })
  child.on('close', (code) => {
    stop()
    // mkvmerge: 0 ok, 1 warnings but file written, 2 error
    if (code === 0 || code === 1) {
      if (phase?.cb) phase.cb(sizes(phase.inputs), Math.max(1, sizes(phase.inputs)))
      resolve()
    } else {
      reject(new Error(`mkvmerge: exit ${code} ${truncate(out, 300)}`))
    }
  })
  return promise
}

/** Display names from 优酷 → ISO 639-2 for mkvmerge `--language`. */
export function mkvLang(lang: string): string {
  const s = lang.trim().toLowerCase()
  if (!s || s === '—' || s === '-') return 'und'
  if (/^(eng?|英语|english)$/.test(s)) return 'eng'
  if (/^(chi|zho|zh|cmn|普通话|国语|中文)$/.test(s)) return 'chi'
  if (/^(jpn|ja|日语|日本)$/.test(s)) return 'jpn'
  if (/粤/.test(s) || s === 'yue') return 'yue'
  if (/^[a-z]{3}$/.test(s)) return s
  return 'und'
}

export function mkvmergeRemux(
  mkvmerge: string,
  inPath: string,
  outPath: string,
  onProgress?: (n: number, total: number) => void,
): Promise<void> {
  return run(mkvmerge, ['-o', outPath, inPath], { out: outPath, inputs: [inPath], cb: onProgress })
}

/**
 * Mux one or more audio tracks into the video file. Video's own audio is
 * dropped (`--no-audio`) so only the selected tracks remain, tagged with
 * title/language. delayMs is an optional ADDITION to the source A/V offset.
 * The actual mux below measures PTS before and after mkvmerge; these arguments
 * alone do not preserve cross-file offsets normalized by the MP4 reader.
 */
export type MuxAudio = { path: string; title?: string; lang?: string; delayMs?: number }

export function mkvmergeMuxArgs(outPath: string, videoPath: string, audios: MuxAudio[]): string[] {
  const args = ['-o', outPath, '--no-audio', '--compression', '0:none', videoPath]
  audios.forEach((a, i) => {
    const delay = a.delayMs ?? 0
    if (!Number.isFinite(delay)) throw new Error('音轨偏移必须是有限毫秒数')
    args.push('--language', `0:${mkvLang(a.lang ?? '')}`)
    if (a.title) args.push('--track-name', `0:${a.title}`)
    args.push('--default-track', `0:${i === 0 ? '1' : '0'}`)
    args.push('--compression', '0:none')
    if (delay) args.push('--sync', `0:${Math.round(delay)}`)
    args.push(a.path)
  })
  return args
}

export async function mkvmergeMux(
  mkvmerge: string,
  videoPath: string,
  audios: MuxAudio[],
  outPath: string,
  onProgress?: (n: number, total: number) => void,
): Promise<void> {
  const ffmpeg = await ensureFFmpeg()
  const report: Record<string, unknown> = { version: 1, video: videoPath, audio: audios.map(a => ({ path: a.path, delayMs: a.delayMs ?? 0 })) }
  let work = ''
  try {
    const sourceVideoMs = await firstPresentationMs(ffmpeg, videoPath, 'v:0')
    const sourceAudioMs: number[] = []
    for (const a of audios) sourceAudioMs.push(await firstPresentationMs(ffmpeg, a.path, 'a:0'))
    const expected = relativePresentationStarts(sourceVideoMs, sourceAudioMs, audios.map(a => a.delayMs ?? 0))
    Object.assign(report, { sourceVideoMs, sourceAudioMs, expectedStartsMs: expected })
    work = mkdtempSync(join(tmpdir(), 'gvs-mux-'))
    const initial = join(work, 'initial.mkv')
    // Do not apply negative adjustments before measuring: that could discard
    // early packets. Correction is done on a single shared Matroska timeline.
    await run(mkvmerge, mkvmergeMuxArgs(initial, videoPath, audios.map(a => ({ ...a, delayMs: 0 }))), {
      out: initial, inputs: [videoPath, ...audios.map(a => a.path)], cb: onProgress,
    })
    const measure = async (path: string) => {
      const starts = [await firstPresentationMs(ffmpeg, path, 'v:0')]
      for (let i = 0; i < audios.length; i++) starts.push(await firstPresentationMs(ffmpeg, path, `a:${i}`))
      return starts
    }
    const initialStarts = await measure(initial)
    // mkvmerge's shift component accepts integer milliseconds (also on v58).
    const corrections = expected.map((v, i) => Math.round(v - initialStarts[i]!))
    Object.assign(report, { initialStartsMs: initialStarts, correctionsMs: corrections })
    let result = initial
    if (corrections.some(n => Math.abs(n) > 2)) {
      const info = await identify(mkvmerge, initial)
      const videoTracks = info.tracks.filter(t => t.type === 'video')
      const audioTracks = info.tracks.filter(t => t.type === 'audio')
      if (videoTracks.length !== 1 || audioTracks.length !== audios.length) throw new Error('封装轨道数量与选择不符')
      const args = ['-o', join(work, 'aligned.mkv')]
      args.push('--sync', `${videoTracks[0]!.id}:${corrections[0]}`)
      audioTracks.forEach((t, i) => args.push('--sync', `${t.id}:${corrections[i + 1]}`))
      // Subtitles from the video input follow the same shift as its video.
      info.tracks.filter(t => t.type === 'subtitles').forEach(t => args.push('--sync', `${t.id}:${corrections[0]}`))
      args.push('--chapter-sync', String(corrections[0]), initial)
      result = join(work, 'aligned.mkv')
      await run(mkvmerge, args, { out: result, inputs: [initial], cb: onProgress })
    }
    const finalStarts = result === initial ? initialStarts : await measure(result)
    report.finalStartsMs = finalStarts
    if (finalStarts.some((v, i) => Math.abs(v - expected[i]!) > 2)) throw new Error('封装后相对起点验证失败，已保留中间文件')
    report.verified = true
    writeFileSync(`${outPath}.timing.json`, JSON.stringify(report, null, 2) + '\n')
    renameSync(result, outPath)
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (e) {
    Object.assign(report, { verified: false, intermediateDirectory: work, error: e instanceof Error ? e.message : String(e) })
    try { writeFileSync(`${outPath}.timing.json`, JSON.stringify(report, null, 2) + '\n') } catch { /* preserve original error */ }
    throw e
  }
}

async function identify(bin: string, path: string): Promise<{ tracks: Array<{ id: number; type: string }> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-J', path], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', b => { out += b })
    child.stderr.on('data', b => { err += b })
    child.once('error', reject)
    child.once('close', code => {
      try { if (code !== 0) throw new Error(`mkvmerge 轨道识别失败: ${err}`); resolve(JSON.parse(out)) } catch (e) { reject(e) }
    })
  })
}
