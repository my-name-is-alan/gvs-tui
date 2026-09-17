import { spawn } from 'node:child_process'
import { existsSync, globSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { homedir } from 'node:os'
import { truncate } from './util.ts'
import { tuiBinDir } from './tool-paths.ts'

function existsFile(p: string): string {
  if (!p || p === 'ffmpeg' || p === 'ffmpeg.exe') return ''
  try {
    return statSync(p).isFile() ? p : ''
  } catch {
    return ''
  }
}

function which(bin: string): string {
  const ext = process.platform === 'win32' ? ['.exe', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    for (const e of ext) {
      const hit = existsFile(join(dir, bin + e))
      if (hit) return hit
    }
  }
  return ''
}

export function lookFFmpeg(bin: string): string {
  const bundled = existsFile(join(tuiBinDir(), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
  if (bundled) return bundled
  const direct = existsFile(bin)
  if (direct) return direct
  const onPath = which('ffmpeg')
  if (onPath) return onPath
  const cfg = process.env.APPDATA || join(homedir(), '.config')
  const home = homedir()
  const local = process.env.LOCALAPPDATA ?? ''
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
  for (const c of [
    join(cfg, 'gvs', 'bin', 'ffmpeg.exe'),
    join(home, 'scoop', 'shims', 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    join(pf, 'ffmpeg', 'bin', 'ffmpeg.exe'),
    join(pf, 'Gyan', 'FFmpeg', 'ffmpeg.exe'),
    join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
  ]) {
    const hit = existsFile(c)
    if (hit) return hit
  }
  if (local || pf) {
    try {
      for (const g of [
        join(local, 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg*', '*', 'bin', 'ffmpeg.exe'),
        join(local, 'Microsoft', 'WinGet', 'Packages', '*', 'bin', 'ffmpeg.exe'),
        join(pf, 'ffmpeg*', 'bin', 'ffmpeg.exe'),
      ]) {
        for (const h of globSync(g.replaceAll('\\', '/'))) {
          const hit = existsFile(h)
          if (hit) return hit
        }
      }
    } catch {
      // glob optional
    }
  }
  return existsSync(bin) ? bin : ''
}

/** 汇总各输入文件的大小，用作「已处理字节」的分母。 */
export type PhaseWatcher = { out: string; inputs?: string[]; cb?: (n: number, total: number) => void }

function sizes(paths: string[] | undefined): number {
  let n = 0
  for (const p of paths ?? []) {
    try {
      n += statSync(p).size
    } catch {
      /* not written yet */
    }
  }
  return n
}

/**
 * ffmpeg 的 `-progress` 只对转码有意义，这里直接盯输出文件大小：解密/封装都是
 * 边读边写，尺寸涨到输入大小就算完成。没有它，几 GB 的解密会长时间停在 80%。
 */
function watchOutput(phase?: PhaseWatcher): () => void {
  if (!phase?.cb) return () => {}
  const timer = setInterval(() => {
    try {
      phase.cb?.(statSync(phase.out).size, Math.max(1, sizes(phase.inputs)))
    } catch {
      /* 输出还没建出来 */
    }
  }, 250)
  return () => clearInterval(timer)
}

function run(ffmpeg: string, args: string[], phase?: PhaseWatcher): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const stop = watchOutput(phase)
  const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d: Buffer) => { out += d.toString() })
  child.stderr.on('data', (d: Buffer) => { out += d.toString() })
  child.on('error', (e) => { stop(); reject(e) })
  child.on('close', (code) => {
    stop()
    if (code === 0 && !/File ended prematurely|partial file|Invalid data found|Error during demuxing/i.test(out)) {
      if (phase?.cb) phase.cb(sizes(phase.inputs), Math.max(1, sizes(phase.inputs)))
      resolve()
    } else {
      reject(new Error(`ffmpeg: exit ${code} ${truncate(out, 300)}`))
    }
  })
  return promise
}

export function ffmpegDecryptCopy(
  ffmpeg: string,
  keyHex: string,
  inPath: string,
  outPath: string,
  onProgress?: (n: number, total: number) => void,
): Promise<void> {
  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  if (keyHex) args.push('-decryption_key', keyHex.toLowerCase().trim())
  args.push('-i', inPath, '-c', 'copy', outPath)
  return run(ffmpeg, args, { out: outPath, inputs: [inPath], cb: onProgress })
}

export function ffmpegRemux(
  ffmpeg: string,
  inPath: string,
  outPath: string,
  onProgress?: (n: number, total: number) => void,
): Promise<void> {
  return run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', inPath, '-c', 'copy', outPath],
    { out: outPath, inputs: [inPath], cb: onProgress })
}

/** Fail before muxing if an encrypted/damaged audio track cannot decode. */
export async function validateAudio(ffmpeg: string, path: string): Promise<void> {
  try {
    await run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-err_detect', 'explode', '-i', path, '-map', '0:a', '-f', 'null', '-'])
  } catch (e) {
    throw new Error(`音轨解码校验失败，未生成成品：${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Mux one or more audio tracks into the video file. Each selected track becomes
 * its own stream in the mkv, tagged with title/language so players can tell an
 * AAC track from a Dolby one.
 */
export function ffmpegMux(
  ffmpeg: string,
  videoPath: string,
  audios: Array<{ path: string; title?: string; lang?: string }>,
  outPath: string,
  onProgress?: (n: number, total: number) => void,
): Promise<void> {
  // Preserve cross-input timestamps; any shift needed for negative DTS must
  // be global. -start_at_zero would normalize each input independently.
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-copyts', '-i', videoPath]
  for (const a of audios) args.push('-i', a.path)
  args.push('-map', '0:v:0')
  audios.forEach((_, i) => args.push('-map', `${i + 1}:a:0`))
  args.push('-c', 'copy')
  audios.forEach((a, i) => {
    if (a.title) args.push(`-metadata:s:a:${i}`, `title=${a.title}`)
    if (a.lang) args.push(`-metadata:s:a:${i}`, `language=${a.lang}`)
  })
  args.push('-disposition:a:0', 'default')
  args.push('-avoid_negative_ts', 'make_non_negative')
  args.push(outPath)
  return run(ffmpeg, args, { out: outPath, inputs: [videoPath, ...audios.map((a) => a.path)], cb: onProgress })
}

export function writeConcatList(paths: string[], listPath: string): void {
  const dir = dirname(listPath)
  const body = paths.map((p) => {
    let rel = relative(dir, p) || basename(p)
    rel = rel.replaceAll('\\', '/').replaceAll("'", String.raw`'\''`)
    return `file '${rel}'`
  }).join('\n')
  writeFileSync(listPath, `${body}\n`)
}
