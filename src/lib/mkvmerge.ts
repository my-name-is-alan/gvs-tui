import { spawn } from 'node:child_process'
import { defaultAudioIndex, orderedMuxAudios } from './audio-selection.ts'
import { statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { truncate } from './util.ts'
import { ensureFFmpeg } from './tools.ts'
import { firstPresentationMs, relativePresentationStarts, isEac3ProbeError, dropFirstAudioPacket } from './media-timing.ts'
import { moveFileSync } from './file-move.ts'
import { removeScratch, scratchDir } from './scratch.ts'
import { isUnknownAudioLanguage, resolveAudioLanguage } from './audio-language.ts'

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

function run(bin: string, args: string[], phase?: Phase, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const stop = watchOutput(phase)
  const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal })
  let out = ''
  child.stdout.on('data', (d: Buffer) => { out += d.toString() })
  child.stderr.on('data', (d: Buffer) => { out += d.toString() })
  child.on('error', (e) => { stop(); reject(signal?.aborted ? (signal.reason ?? e) : e) })
  child.on('close', (code) => {
    stop()
    if (signal?.aborted) { reject(signal.reason ?? new Error('已停止')); return }
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
  if (/^(aac|dolby|dts|atmos|eac3|ac3|ec3)$/.test(s)) return 'und'
  if (/^(eng?|英语|english)$/.test(s)) return 'eng'
  if (/^(chi|zho|zh|cmn|普通话|国语|中文)$/.test(s)) return 'chi'
  if (/^(jpn|ja|日语|日本)$/.test(s)) return 'jpn'
  if (/粤/.test(s) || s === 'yue') return 'yue'
  if (/^(nan|闽南|闽南语)$/.test(s)) return 'nan'
  // Common BCP 47 and two-letter labels returned by providers/source containers.
  const code = s.split(/[-_]/)[0]!
  const iso: Record<string, string> = { zh: 'chi', en: 'eng', ja: 'jpn', ko: 'kor', fr: 'fre', de: 'ger', es: 'spa', it: 'ita', pt: 'por', ru: 'rus', th: 'tha', vi: 'vie', id: 'ind' }
  if (iso[code]) return iso[code]!
  if (/^[a-z]{3}$/.test(code)) return code
  return 'und'
}

export async function mkvmergeRemux(
  mkvmerge: string,
  inPath: string,
  outPath: string,
  onProgress?: (n: number, total: number) => void,
  signal?: AbortSignal,
  audioLanguageFallback = '',
): Promise<void> {
  const args = ['-o', outPath]
  const info = await identify(mkvmerge, inPath, signal)
  for (const track of info.tracks.filter(t => t.type === 'audio')) {
    args.push('--track-name', `${track.id}:`)
    if (audioLanguageFallback && isUnknownAudioLanguage(trackLanguage(track))) args.push('--language', `${track.id}:${audioLanguageFallback}`)
  }
  args.push(inPath)
  return run(mkvmerge, args, { out: outPath, inputs: [inPath], cb: onProgress }, signal)
}

/**
 * Mux one or more audio tracks into the video file. Video's own audio is
 * dropped (`--no-audio`) so only the selected tracks remain, with language and
 * default flags and no track titles. delayMs adds to the source A/V offset.
 * The actual mux below measures PTS before and after mkvmerge; these arguments
 * alone do not preserve cross-file offsets normalized by the MP4 reader.
 */
export type MuxAudio = { path: string; title?: string; lang?: string; delayMs?: number; isDefault?: boolean }

export function mkvmergeMuxArgs(outPath: string, videoPath: string, audios: MuxAudio[]): string[] {
  audios = orderedMuxAudios(audios)
  const args = ['-o', outPath, '--no-audio', '--compression', '0:none', videoPath]
  const defaultIndex = defaultAudioIndex(audios)
  audios.forEach((a, i) => {
    const delay = a.delayMs ?? 0
    if (!Number.isFinite(delay)) throw new Error('音轨偏移必须是有限毫秒数')
    args.push('--language', `0:${mkvLang(a.lang ?? '')}`)
    args.push('--track-name', '0:')
    args.push('--default-track', `0:${i === defaultIndex ? '1' : '0'}`)
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
  signal?: AbortSignal,
  onWarning?: (message: string) => void,
  audioLanguageFallback = '',
): Promise<void> {
  audios = orderedMuxAudios(audios)
  const ffmpeg = await ensureFFmpeg()
  const report: Record<string, unknown> = { version: 1, video: videoPath, audio: audios.map(a => ({ path: a.path, delayMs: a.delayMs ?? 0 })) }
  let work = ''
  try {
    work = scratchDir(outPath, 'gvs-mux-')
    // Catalog "原声" is not a language. Preserve meaningful input tags before
    // applying the TMDB fallback, and do this before any damaged-frame repair.
    await Promise.all(audios.map(async a => {
      if (!isUnknownAudioLanguage(a.lang)) return
      try {
        const info = await identify(mkvmerge, a.path, signal)
        const track = info.tracks.find(t => t.type === 'audio')
        a.lang = resolveAudioLanguage(a.lang, track && trackLanguage(track), audioLanguageFallback)
      } catch (e) {
        signal?.throwIfAborted()
        // Language inspection alone must not disable an otherwise usable input.
        a.lang = 'und'
        onWarning?.('未能读取源音轨语言，保留未知标签')
      }
    }))
    const repairs: Array<{ track: number; message: string }> = []
    const [sourceVideoMs, ...sourceAudioMs] = await Promise.all([
      firstPresentationMs(ffmpeg, videoPath, 'v:0', signal),
      ...audios.map(async (a, i) => {
        try {
          return await firstPresentationMs(ffmpeg, a.path, 'a:0', signal)
        } catch (e) {
          signal?.throwIfAborted()
          if (!(e instanceof Error) || !isEac3ProbeError(e.message)) throw e
          const repaired = join(work, `audio-${i}-repaired.mka`)
          await dropFirstAudioPacket(ffmpeg, a.path, repaired, signal)
          const start = await firstPresentationMs(ffmpeg, repaired, 'a:0', signal)
          a.path = repaired
          const message = `音轨 ${i + 1} 已跳过异常首帧，保留后续时间戳；完整音轨解码校验通过`
          repairs.push({ track: i, message })
          report.audioRepairs = repairs
          onWarning?.(message)
          return start
        }
      }),
    ])
    signal?.throwIfAborted()
    const expected = relativePresentationStarts(sourceVideoMs, sourceAudioMs, audios.map(a => a.delayMs ?? 0))
    Object.assign(report, { sourceVideoMs, sourceAudioMs, expectedStartsMs: expected })
    const initial = join(work, 'initial.mkv')
    // Do not apply negative adjustments before measuring: that could discard
    // early packets. Correction is done on a single shared Matroska timeline.
    await run(mkvmerge, mkvmergeMuxArgs(initial, videoPath, audios.map(a => ({ ...a, delayMs: 0 }))), {
      out: initial, inputs: [videoPath, ...audios.map(a => a.path)], cb: onProgress,
    }, signal)
    const measure = async (path: string) => Promise.all([
      firstPresentationMs(ffmpeg, path, 'v:0', signal),
      ...audios.map((_, i) => firstPresentationMs(ffmpeg, path, `a:${i}`, signal)),
    ])
    const initialStarts = await measure(initial)
    // mkvmerge's shift component accepts integer milliseconds (also on v58).
    const corrections = expected.map((v, i) => Math.round(v - initialStarts[i]!))
    Object.assign(report, { initialStartsMs: initialStarts, correctionsMs: corrections })
    let result = initial
    if (corrections.some(n => Math.abs(n) > 2)) {
      const info = await identify(mkvmerge, initial, signal)
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
      await run(mkvmerge, args, { out: result, inputs: [initial], cb: onProgress }, signal)
    }
    const finalStarts = result === initial ? initialStarts : await measure(result)
    report.finalStartsMs = finalStarts
    if (finalStarts.some((v, i) => Math.abs(v - expected[i]!) > 2)) throw new Error('封装后相对起点验证失败，已保留中间文件')
    report.verified = true
    writeFileSync(`${outPath}.timing.json`, JSON.stringify(report, null, 2) + '\n')
    moveFileSync(result, outPath)
    removeScratch(work)
  } catch (e) {
    Object.assign(report, { verified: false, intermediateDirectory: work, error: e instanceof Error ? e.message : String(e) })
    try { writeFileSync(`${outPath}.timing.json`, JSON.stringify(report, null, 2) + '\n') } catch { /* preserve original error */ }
    throw e
  }
}

type IdentifiedTrack = { id: number; type: string; properties?: { language?: string; language_ietf?: string } }

function trackLanguage(track: IdentifiedTrack): string {
  const { language_ietf, language } = track.properties ?? {}
  return !isUnknownAudioLanguage(language_ietf) ? language_ietf! : language ?? ''
}

async function identify(bin: string, path: string, signal?: AbortSignal): Promise<{ tracks: IdentifiedTrack[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-J', path], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal })
    let out = '', err = ''
    child.stdout.on('data', b => { out += b })
    child.stderr.on('data', b => { err += b })
    child.once('error', reject)
    child.once('close', code => {
      if (signal?.aborted) { reject(signal.reason); return }
      try { if (code !== 0 && code !== 1) throw new Error(`mkvmerge 轨道识别失败: ${err}`); resolve(JSON.parse(out)) } catch (e) { reject(e) }
    })
  })
}
