import { spawn } from 'node:child_process'
import { existsSync, renameSync, unlinkSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { isCodecProbeDiagnostic } from './media-timing.ts'

export type IQAudioInput = { path: string; id: string; title: string; codec: string; parts: string[] }

export function runIQFFmpeg(bin: string, args: string[], context: string, signal?: AbortSignal,
  options: { onCodecDiagnostic?: (diagnostic: string) => void } = {}): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-nostats', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal })
    let first = '', last = ''
    child.stderr.on('data', data => {
      const text = data.toString()
      if (first.length < 2000) first = (first + text).slice(0, 2000)
      last = (last + text).slice(-1000)
    })
    child.once('error', reject)
    child.once('close', code => {
      if (signal?.aborted) { reject(signal.reason); return }
      if (code === 0 && !first.trim()) { resolve(); return }
      // A successful domestic stream-copy can emit recoverable codec probe hints.
      // Retain only bounded codec diagnostics; truncated output or mux errors fail.
      if (code === 0 && first.length < 2000 && options.onCodecDiagnostic && isCodecProbeDiagnostic(first)) {
        options.onCodecDiagnostic(first)
        resolve()
        return
      }
      const detail = first.length < 2000 ? first : `${first}\n…\n${last}`
      reject(new Error(`${context} (${code}): ${detail.trim()}`))
    })
  })
}

/** Preserve downloaded bytes but do not reuse a track that failed decoding. */
export async function verifyIQAudio(bin: string, input: IQAudioInput, signal?: AbortSignal): Promise<void> {
  try {
    await runIQFFmpeg(bin, ['-xerror', '-err_detect', 'explode', '-i', input.path, '-map', '0:a:0', '-f', 'null', '-'],
      `IQ 独立音轨验收失败：${input.title} [${input.id} / ${input.codec.toUpperCase()}]`, signal)
  } catch (error) {
    signal?.throwIfAborted()
    for (const part of input.parts) {
      for (const suffix of ['.complete.json', '.resume.json', '.parts.json']) {
        try { unlinkSync(part + suffix) } catch { /* no reusable state */ }
      }
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n已保留视频和音轨字节；重试会重新下载这条失败音轨。`, { cause: error })
  }
}

/** Publish only after the muxed audio passes; failed attempts cannot look finished. */
export async function writeIQOutput(dest: string, write: (partial: string) => Promise<void>, verify: (partial: string) => Promise<void>, signal?: AbortSignal): Promise<void> {
  const extension = extname(dest)
  const partial = join(dirname(dest), `.${basename(dest, extension)}.iq-partial${extension}`)
  if (existsSync(dest)) throw new Error('IQ 成品路径已存在，请更换输出文件名')
  try {
    signal?.throwIfAborted()
    await write(partial)
    await verify(partial)
    signal?.throwIfAborted()
    if (existsSync(dest)) throw new Error('IQ 成品路径已存在，请更换输出文件名')
    renameSync(partial, dest)
  } catch (error) {
    try { unlinkSync(partial) } catch { /* no mux output yet */ }
    throw error
  }
}
