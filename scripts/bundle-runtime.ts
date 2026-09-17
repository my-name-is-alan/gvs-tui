// Copy the installed runtime dependency graph, including native DLLs and WASM,
// without depending on an ancestor node_modules directory or Bun auto-install.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const dist = join(root, 'dist')
const modules = join(dist, 'node_modules')
type Package = { name: string; version: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; os?: string[]; cpu?: string[] }
const copied = new Map<string, { version: string; source: string }>()

function locate(name: string, from: string): string {
  // Bun's isolated linker creates node_modules links alongside the package.
  let current = from
  for (;;) {
    const candidate = join(current, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    const parent = dirname(current)
    if (parent === current) throw new Error(`缺少运行依赖 ${name}，请先 bun install --frozen-lockfile`)
    current = parent
  }
}
function compatible(values: string[] | undefined, actual: string): boolean {
  return !values || (!values.includes(`!${actual}`) && (!values.some(v => !v.startsWith('!')) || values.includes(actual)))
}
function copyPackage(name: string, from: string, optional = false): void {
  let source: string
  try { source = locate(name, from) } catch (e) { if (optional) return; throw e }
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as Package
  if (!compatible(pkg.os, process.platform) || !compatible(pkg.cpu, process.arch)) {
    if (optional) return
    throw new Error(`运行依赖 ${name} 不支持 ${process.platform}/${process.arch}`)
  }
  const previous = copied.get(name)
  if (previous) {
    if (previous.version !== pkg.version) throw new Error(`运行依赖版本冲突：${name}`)
    return
  }
  copied.set(name, { version: pkg.version, source })
  const destination = join(modules, name)
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true, dereference: true,
    filter: path => path === source || !['node_modules', '.git'].includes(basename(path)) })
  for (const dependency of Object.keys(pkg.dependencies ?? {})) copyPackage(dependency, source)
  // Type-only peers are not used at runtime. OpenTUI's WASM peer is required.
  for (const dependency of Object.keys(pkg.peerDependencies ?? {})) {
    if (dependency !== 'typescript' && !dependency.startsWith('@types/')) copyPackage(dependency, source)
  }
  for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) copyPackage(dependency, source, true)
}

mkdirSync(modules, { recursive: true })
copyPackage('@opentui/core', root)
if (!copied.has(`@opentui/core-${process.platform}-${process.arch}`)) throw new Error('OpenTUI 原生运行库未打包')
const project = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
writeFileSync(join(dist, 'package.json'), JSON.stringify({ name: 'gvs-tui-portable', version: project.version, private: true, type: 'module',
  dependencies: { '@opentui/core': copied.get('@opentui/core')!.version } }, null, 2) + '\n')
writeFileSync(join(dist, 'runtime-manifest.json'), JSON.stringify({ platform: process.platform, arch: process.arch,
  packages: [...copied].map(([name, p]) => ({ name, version: p.version })) }, null, 2) + '\n')
console.log(`运行依赖已打包：${copied.size} 个包，含 OpenTUI 原生库`)
