// Verify the exact Git-shipped binaries without invoking any network fallback.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { ensureTools, tuiBinDir } from '../src/lib/tools.ts'

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('仓库媒体工具仅适用于 Windows x64')
const expectedDir = resolve(import.meta.dir, '../bin')
if (resolve(tuiBinDir()) !== expectedDir) throw new Error('工具路径没有指向仓库 bin')
const manifest = JSON.parse(readFileSync(join(expectedDir, 'manifest.json'), 'utf8')) as {
  tools: Array<{ name: string; bytes: number; sha256: string }>
}
const required = ['ffmpeg.exe', 'mkvmerge.exe', 'N_m3u8DL-RE.exe', 'packager-win-x64.exe', 'MP4Box.exe']
if (manifest.tools.length !== required.length || required.some(name => !manifest.tools.some(t => t.name === name))) throw new Error('媒体工具清单不完整')
for (const tool of manifest.tools) {
  const data = readFileSync(join(expectedDir, tool.name))
  if (data.length !== tool.bytes || createHash('sha256').update(data).digest('hex') !== tool.sha256) throw new Error(`${tool.name} 不完整或与清单不符`)
}
globalThis.fetch = (() => { throw new Error('仓库工具校验禁止联网') }) as typeof fetch
await ensureTools()
for (const name of required) {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(join(expectedDir, name), [name === 'ffmpeg.exe' || name === 'MP4Box.exe' ? '-version' : '--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let info = ''
    const timeout = setTimeout(() => { p.kill(); reject(new Error(`${name} 启动超时`)) }, 20000)
    p.stdout.on('data', b => { info += b })
    p.stderr.on('data', b => { info += b })
    p.once('error', e => { clearTimeout(timeout); reject(e) })
    p.once('close', code => {
      clearTimeout(timeout)
      if (code !== 0) reject(new Error(`${name} 无法独立启动: ${info.slice(0,300)}`))
      else { console.log(`PASS: ${name} SHA-256 + offline startup`); resolve() }
    })
  })
}
console.log('仓库工具完整，准备过程无需联网下载')
