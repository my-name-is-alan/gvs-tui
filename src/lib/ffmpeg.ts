import { spawn } from 'node:child_process'
import { existsSync, globSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { homedir } from 'node:os'
import { truncate } from './util.ts'

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

function run(ffmpeg: string, args: string[], cwd?: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const child = spawn(ffmpeg, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d: Buffer) => { out += d.toString() })
  child.stderr.on('data', (d: Buffer) => { out += d.toString() })
  child.on('error', reject)
  child.on('close', (code) => {
    if (code === 0) resolve()
    else reject(new Error(`ffmpeg: exit ${code} ${truncate(out, 300)}`))
  })
  return promise
}

export function ffmpegDecryptCopy(ffmpeg: string, keyHex: string, inPath: string, outPath: string): Promise<void> {
  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  if (keyHex) args.push('-decryption_key', keyHex.toLowerCase().trim())
  args.push('-i', inPath, '-c', 'copy', outPath)
  return run(ffmpeg, args)
}

export function ffmpegRemux(ffmpeg: string, inPath: string, outPath: string): Promise<void> {
  return run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', inPath, '-c', 'copy', outPath])
}

/** Mux a separate audio track into the video file (优酷多音轨). */
export function ffmpegMux(ffmpeg: string, videoPath: string, audioPath: string, outPath: string): Promise<void> {
  return run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', videoPath, '-i', audioPath,
    '-map', '0:v', '-map', '1:a',
    '-c', 'copy', outPath,
  ])
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
