import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { ensureFFmpeg, ensureM3u8dl, ensureMkvmerge, ensurePackager, tuiBinDir } from '../src/lib/tools.ts'

// Build-time acquisition: release users receive these binaries in dist/bin.
const target = resolve(import.meta.dir, '../dist/bin')
const prepare = process.argv.includes('--prepare')
const tools = [ensureFFmpeg, ensureM3u8dl, ensureMkvmerge, ensurePackager]
const manifest: Array<{ name: string; sha256: string }> = []
for (const ensure of tools) {
  const source = await ensure(console.log)
  const destination = resolve(prepare ? tuiBinDir() : target, basename(source))
  mkdirSync(prepare ? tuiBinDir() : target, { recursive: true })
  if (resolve(source) !== destination) copyFileSync(source, destination)
  manifest.push({ name: basename(source), sha256: createHash('sha256').update(readFileSync(destination)).digest('hex') })
}
if (!prepare) {
  copyFileSync(resolve(import.meta.dir, '../docs/THIRD-PARTY-TOOLS.md'), resolve(target, 'THIRD-PARTY-TOOLS.md'))
  writeFileSync(resolve(target, 'manifest.json'), JSON.stringify({ platform: process.platform, arch: process.arch, tools: manifest }, null, 2) + '\n')
}
console.log(`内置工具已准备：${prepare ? tuiBinDir() : target}`)
