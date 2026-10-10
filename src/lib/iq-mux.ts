import { spawn } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { defaultAudioIndex, orderedMuxAudios } from './audio-selection.ts'
import { defaultIQSubtitleIndex, prepareIQSubtitles } from './iq-subtitles.ts'
import type { IQSubtitleFile } from './iq-subtitles.ts'
export { defaultIQSubtitleIndex, orderedIQSubtitles } from './iq-subtitles.ts'

type IQMuxInput = { path: string; language: string; title: string; isDefault?: boolean }
type IQMuxOptions = {
  video: string
  audios: readonly IQMuxInput[]
  subtitles: readonly IQSubtitleFile[]
  dest: string
  /** The shared job runner owns an empty reservation for measured naming. */
  reservedOutput: boolean
  signal?: AbortSignal
  emit: (status: string, pct: number, log: string) => void
}

function ffmpeg(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-nostats', '-nostdin', ...args],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal })
    let error = ''
    child.stderr.on('data', data => { error += data.toString(); if (error.length > 4096) error = error.slice(-4096) })
    child.once('error', reject)
    child.once('close', code => code === 0 && !error.trim() ? resolve()
      : reject(new Error(`IQ 封装或音轨验收失败 (${code}): ${error.slice(-250)}`)))
  })
}

/** Mux to a fresh same-volume path, then replace only the job's unchanged empty reservation. */
export async function muxIQ(bin: string, options: IQMuxOptions): Promise<{ index: number; count: number; note?: string }> {
  const { video, dest, reservedOutput, signal, emit } = options
  const audios = orderedMuxAudios(options.audios)
  signal?.throwIfAborted()
  mkdirSync(dirname(dest), { recursive: true })
  const reservation = reservedOutput ? lstatSync(dest) : undefined
  if (reservation && (!reservation.isFile() || reservation.size !== 0)) throw new Error('IQ 输出占位已改变，未覆盖现有文件')
  const stage = mkdtempSync(join(dirname(dest), '.gvs-iq-mux-'))
  const output = reservedOutput ? join(stage, `output${extname(dest)}`) : dest
  const index = defaultAudioIndex(audios)
  try {
    const prepared = await prepareIQSubtitles(options.subtitles, stage, signal)
    const subtitles = prepared.subtitles
    const subtitleIndex = defaultIQSubtitleIndex(subtitles)
    if (prepared.note) emit('字幕处理', 0.9, prepared.note)
    const args = ['-i', video, ...audios.flatMap(a => ['-i', a.path]), ...subtitles.flatMap(s => ['-i', s.path]), '-map', '0:v:0']
    for (let i = 0; i < audios.length; i++) args.push('-map', `${i + 1}:a:0`)
    for (let i = 0; i < subtitles.length; i++) args.push('-map', `${1 + audios.length + i}:s:0`)
    args.push('-c', 'copy', '-metadata:s:v:0', 'language=zho', '-metadata:s:a', 'title=', '-metadata:s:a', 'handler_name=')
    audios.forEach((a, i) => args.push(`-metadata:s:a:${i}`, `language=${a.language}`,
      `-disposition:a:${i}`, i === index ? 'default' : '0'))
    subtitles.forEach((s, i) => args.push(`-metadata:s:s:${i}`, `language=${s.language}`,
      `-metadata:s:s:${i}`, `title=${s.title}`, `-disposition:s:${i}`, i === subtitleIndex ? 'default' : '0'))
    args.push('-n', output)
    await ffmpeg(bin, args, signal)
    emit('音轨验收', 0.97, '检查所有合流音轨')
    await ffmpeg(bin, ['-i', output, '-map', '0:a', '-f', 'null', '-'], signal)
    signal?.throwIfAborted()
    if (reservation) {
      const current = lstatSync(dest)
      if (!current.isFile() || current.size !== 0 || current.ino !== reservation.ino || current.dev !== reservation.dev)
        throw new Error('IQ 输出占位已改变，未覆盖现有文件')
      renameSync(output, dest)
    }
    return { index, count: audios.length, ...(prepared.note ? { note: prepared.note } : {}) }
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true })
  }
}
