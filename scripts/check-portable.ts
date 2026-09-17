// Runs an extracted portable bundle outside this checkout with auto-install
// disabled; package/native-library resolution cannot use the developer tree.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
const root = resolve(import.meta.dir, '..')
const version = (await Bun.file(join(root, 'package.json')).json()).version
const archive = resolve(process.argv[2] ?? join(root, '.build', 'releases', `gvs-tui-${version}-windows-x64.zip`))
const target = mkdtempSync(join(tmpdir(), 'gvs-portable-isolated-'))
async function run(bin: string, args: string[], cwd = target, env = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timeout = setTimeout(() => { p.kill(); reject(new Error(`验证超时：${bin}`)) }, 30000)
    p.stdout.on('data', b => { out += b })
    p.stderr.on('data', b => { err += b })
    p.once('error', e => { clearTimeout(timeout); reject(e) })
    p.once('close', code => { clearTimeout(timeout); code === 0 ? resolve(out) : reject(new Error(`${bin}: ${code} ${err}`)) })
  })
}
await run('tar', ['-xf', archive, '-C', target])
const probe = join(target, 'portable-smoke.mjs')
writeFileSync(probe, `
globalThis.fetch = async () => { throw new Error('Network forbidden during portable smoke test') }
const { createTestRenderer } = await import('@opentui/core/testing')
const { TextRenderable } = await import('@opentui/core')
const setup = await createTestRenderer({width: 40, height: 4})
setup.renderer.root.add(new TextRenderable(setup.renderer, {id:'smoke', content:'GVS portable native runtime OK'}))
await setup.renderOnce()
if (!setup.captureCharFrame().includes('GVS portable')) throw new Error('Native rendering failed')
setup.renderer.destroy()
const source = await Bun.file(new URL('./main.js', import.meta.url)).text()
for (const match of source.matchAll(/from["']([^"']+)["']/g)) {
  if (!match[1].startsWith('node:')) await import(match[1])
}
console.log('PASS: offline dependencies and native rendering')
process.exit(0)
`)
const env = { ...process.env, NODE_PATH: '', GVS_PREVIEW: 'home' }
console.log((await run(join(target, 'runtime', 'bun.exe'), ['--no-install', '--bun', probe], target, env)).trim())
for (const [file, args] of [['ffmpeg.exe', ['-version']], ['N_m3u8DL-RE.exe', ['--version']], ['mkvmerge.exe', ['--version']], ['packager-win-x64.exe', ['--version']]] as const) {
  await run(join(target, 'bin', file), [...args])
  console.log(`PASS: ${file}`)
}
if (!existsSync(join(target, 'start.cmd'))) throw new Error('缺少启动器')
console.log(`便携包离线校验通过：${target}`)
