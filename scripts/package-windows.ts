import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('便携包需要在 Windows x64 上构建')
const root = resolve(import.meta.dir, '..'), dist = join(root, 'dist')
for (const file of ['main.js', 'node_modules/@opentui/core/package.json', 'node_modules/@opentui/core-win32-x64/package.json',
  'bin/ffmpeg.exe', 'bin/N_m3u8DL-RE.exe', 'bin/mkvmerge.exe', 'bin/packager-win-x64.exe']) {
  if (!existsSync(join(dist, file))) throw new Error(`打包缺少 ${file}，请先 bun run build`)
}
mkdirSync(join(dist, 'runtime'), { recursive: true })
copyFileSync(process.execPath, join(dist, 'runtime', 'bun.exe'))
writeFileSync(join(dist, 'start.cmd'), '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\bun.exe" --no-install --bun "%~dp0main.js"\r\nif errorlevel 1 pause\r\n')
writeFileSync(join(dist, '使用说明.txt'), 'Windows x64 完整便携包\r\n解压到可写目录后双击 start.cmd。已包含 Bun、OpenTUI 运行依赖和四个媒体工具，无需安装 Node、Bun 或另下工具。\r\n首次运行仍需填写自己的网关地址/API Key，并登录自己的平台账号。\r\n不要只复制 main.js 或 bin；请保留整个解压目录。\r\n软件和组件来源见 THIRD-PARTY-TOOLS.md、runtime-manifest.json。\r\n')
copyFileSync(join(root, 'docs', 'THIRD-PARTY-TOOLS.md'), join(dist, 'THIRD-PARTY-TOOLS.md'))
const releases = join(root, '.build', 'releases')
mkdirSync(releases, { recursive: true })
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const archive = join(releases, `gvs-tui-${version}-windows-x64.zip`)
await new Promise<void>((resolve, reject) => {
  const p = spawn('tar', ['-a', '-cf', archive, '-C', dist, '.'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let error = ''
  p.stderr.on('data', b => { error += b })
  p.once('error', reject)
  p.once('close', code => code === 0 ? resolve() : reject(new Error(`打包失败: ${error}`)))
})
writeFileSync(`${archive}.sha256`, `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  ${archive.split(/[\\/]/).at(-1)}\n`)
console.log(`便携包：${archive}`)
