import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const option = (name, fallback) => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
const platform = option('platform', process.platform)
const arch = option('arch', process.arch)
const goos = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[platform]
const goarch = { x64: 'amd64', arm64: 'arm64' }[arch]
if (!goos || !goarch) throw new Error('Unsupported mobile42 helper target')
// Build the reviewed shared decoder, never a separately maintained Node port.
const source = resolve(option('source', process.env.GVS_GATEWAY_SOURCE || resolve(root, '../get_video_streaming')))
const pins = JSON.parse(readFileSync(resolve(root, 'scripts/mobile42-decoder-sources.json'), 'utf8'))
for (const [path, expected] of Object.entries(pins)) {
  const actual = createHash('sha256').update(readFileSync(resolve(source, path))).digest('hex')
  if (actual !== expected) throw new Error(`Shared mobile42 decoder source changed: ${path}; review and update source pins`)
}
const output = resolve(root, option('output', `bin/tencent-mobile42-decode${platform === 'win32' ? '.exe' : ''}`))
mkdirSync(dirname(output), { recursive: true })
const child = spawnSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', output, './cmd/tencent-mobile42-decode'], {
  cwd: source, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0', GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' },
})
if (child.error) throw child.error
if (child.status !== 0) process.exit(child.status || 1)
writeFileSync(`${output}.sha256`, createHash('sha256').update(readFileSync(output)).digest('hex') + '\n')
console.log(`Built mobile42 decoder for ${platform}/${arch}`)
