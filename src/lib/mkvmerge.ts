import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { truncate } from './util.ts'

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
 * title/language.
 */
export function mkvmergeMux(
  mkvmerge: string,
  videoPath: string,
  audios: Array<{ path: string; title?: string; lang?: string }>,
  outPath: string,
  onProgress?: (n: number, total: number) => void,
): Promise<void> {
  const args = ['-o', outPath, '--no-audio', videoPath]
  audios.forEach((a, i) => {
    args.push('--language', `0:${mkvLang(a.lang ?? '')}`)
    if (a.title) args.push('--track-name', `0:${a.title}`)
    args.push('--default-track', `0:${i === 0 ? '1' : '0'}`)
    args.push(a.path)
  })
  return run(mkvmerge, args, { out: outPath, inputs: [videoPath, ...audios.map((a) => a.path)], cb: onProgress })
}
