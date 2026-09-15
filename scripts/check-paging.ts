// Drive the real Runtime: search a provider that has more pages, walk to the
// bottom of the list, and check that the next page is fetched and appended.
//   PROBE_HOST=http://127.0.0.1:8080 bun run scripts/check-paging.ts [query]
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const realPath = join(process.env.APPDATA ?? '', 'gvs', 'tui.json')
const real = JSON.parse(readFileSync(realPath, 'utf8')) as Record<string, unknown>
process.env.APPDATA = mkdtempSync(join(tmpdir(), 'gvs-page-'))

const { Runtime } = await import('../src/runtime.ts')
const { loadConfig, saveConfig } = await import('../src/lib/config.ts')
const cfg = loadConfig()
Object.assign(cfg, real)
if (process.env.PROBE_HOST) cfg.host = process.env.PROBE_HOST
saveConfig(cfg)

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const query = process.argv[2] ?? '斗破苍穹'
const rt = new Runtime()
await wait(2000)

// home → 搜索（homeItems 第二项）
const items = rt.snapshot.homeItems ?? []
const searchIdx = Math.max(0, items.indexOf('搜索'))
for (let i = 0; i < searchIdx; i++) rt.handleKey('j')
rt.handleKey('enter')
await wait(300)
const providers = rt.snapshot.providers ?? []
console.log(`scene=${rt.snapshot.scene} providers=${providers.join(',')} idx=${rt.snapshot.providerIndex}`)

// 选腾讯（分页字段最全）
const want = Math.max(0, providers.indexOf('tencent'))
for (let i = 0; i < 8 && rt.snapshot.providerIndex !== want; i++) {
  rt.handleKey('right')
  await wait(60)
}
console.log(`providerIndex=${rt.snapshot.providerIndex} (${providers[rt.snapshot.providerIndex ?? 0]})`)
rt.set('query', query)
await wait(200)
rt.handleKey('enter')
await wait(6000)

const first = rt.snapshot.rows?.length ?? 0
console.log(`搜索后: rows=${first} listMore=${rt.snapshot.listMore} status=${rt.snapshot.status}`)
if (!first) {
  rt.close()
  process.exit(1)
}

// 走到列表底部再多按一次，触发翻页
for (let i = 0; i < first; i++) rt.handleKey('j')
await wait(6000)
const second = rt.snapshot.rows?.length ?? 0
console.log(`到底部后: rows=${second} listMore=${rt.snapshot.listMore} status=${rt.snapshot.status}`)

// 再翻一页（如果还有）
if (rt.snapshot.listMore) {
  rt.handleKey('j')
  await wait(6000)
  console.log(`再翻一页: rows=${rt.snapshot.rows?.length ?? 0} listMore=${rt.snapshot.listMore} status=${rt.snapshot.status}`)
}

const ok = second > first
console.log(ok ? `✓ 分页生效：${first} → ${second} 条` : '✗ 没有加载下一页')
rt.close()
process.exit(ok ? 0 : 1)
