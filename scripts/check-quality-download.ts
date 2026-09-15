// 端到端验证「选中的档位 = 实际下载的流」：挑最小的一档（360P）下载，检查产物大小与文件名。
//   PROBE_HOST=http://127.0.0.1:8080 bun run scripts/check-quality-download.ts
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const realPath = join(process.env.APPDATA ?? '', 'gvs', 'tui.json')
const real = JSON.parse(readFileSync(realPath, 'utf8')) as Record<string, unknown>
process.env.APPDATA = mkdtempSync(join(tmpdir(), 'gvs-qdl-'))

const { Runtime } = await import('../src/runtime.ts')
const { loadConfig, saveConfig } = await import('../src/lib/config.ts')
const cfg = loadConfig()
Object.assign(cfg, real)
if (process.env.PROBE_HOST) cfg.host = process.env.PROBE_HOST
cfg.youkuSign = '' // 本地网关不认线上签名
cfg.outDir = join(process.env.APPDATA, 'out')
saveConfig(cfg)

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rt = new Runtime()
await wait(2000)

// home → 榜单（优酷内容，档位最全）
const items = rt.snapshot.homeItems ?? []
const rankIdx = Math.max(0, items.indexOf('榜单'))
for (let i = 0; i < rankIdx; i++) rt.handleKey('j')
rt.handleKey('enter')
await wait(6000)
console.log(`榜单: scene=${rt.snapshot.scene} rows=${rt.snapshot.rows?.length}`)

rt.handleKey('enter')            // 打开第一条
await wait(8000)
console.log(`详情: scene=${rt.snapshot.scene} title=${rt.snapshot.detail?.title} eps=${rt.snapshot.episodes?.length}`)

rt.handleKey('enter')            // 下第一集 → 取画质
for (let i = 0; i < 20 && rt.snapshot.scene !== 'quality'; i++) await wait(1000)
const qs = rt.snapshot.qualities ?? []
console.log(`画质: ${qs.length} 档 — ${qs.map((q) => `${q.label}/${(q.size / 1048576).toFixed(0)}MB`).join('  ')}`)
if (rt.snapshot.scene !== 'quality' || !qs.length) {
  console.log(`失败：status=${rt.snapshot.status}`)
  rt.close()
  process.exit(1)
}

// 选到最后一档（最小），确认光标确实落在它上面
for (let i = 0; i < qs.length - 1; i++) rt.handleKey('j')
await wait(300)
const picked = qs[rt.snapshot.qualityIndex ?? 0]
console.log(`选中: ${picked?.label} ${picked?.width}x${picked?.height} ${((picked?.size ?? 0) / 1048576).toFixed(0)} MB  id=${picked?.id}`)

rt.handleKey('enter')            // 开始下载
let done = 0
for (let i = 0; i < 90; i++) {
  await wait(1000)
  const job = rt.snapshot.jobs?.[0]
  if (!job) continue
  if (job.status === '完成' || job.status === '失败') {
    done = 1
    console.log(`任务: ${job.status} pct=${job.pct}
      log=${job.log}
      err=${job.err}`)
    break
  }
  if (i % 5 === 4) console.log(`  …${job.status} ${Math.round((job.pct ?? 0) * 100)}% ${job.log}`)
}
if (!done) console.log('任务未在 90s 内结束（可能仍在解密/封装）')

const outDir = cfg.outDir
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
)
const files = walk(outDir).filter((f) => !f.includes('.part') && !/\\\.[^\\]*$/.test(f))
for (const f of files) {
  console.log(`产物: ${f.replace(outDir, '')}  ${(statSync(f).size / 1048576).toFixed(1)} MB`)
}
const expectMb = (picked?.size ?? 0) / 1048576
const actualMb = files.length ? statSync(files[0]!).size / 1048576 : 0
const ok = files.length > 0 && Math.abs(actualMb - expectMb) / Math.max(expectMb, 1) < 0.35
console.log(ok ? `✓ 实际下载的就是选中的档位（预期 ~${expectMb.toFixed(0)} MB）` : `✗ 产物 ${actualMb.toFixed(0)} MB 与选中档位 ${expectMb.toFixed(0)} MB 不符`)
rt.close()
process.exit(ok ? 0 : 1)
