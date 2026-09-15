// Drive the real Runtime through the user's flow against a gateway, without a
// renderer: 榜单 → 详情 → 选集 → 取画质/音轨. Prints the snapshot at each step.
//   PROBE_HOST=http://127.0.0.1:8080 bun run scripts/flow-check.ts [provider]
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Keep the real key, but point the runtime at a scratch config dir so the run
// cannot touch the user's file.
const realPath = join(process.env.APPDATA ?? '', 'gvs', 'tui.json')
const real = JSON.parse(readFileSync(realPath, 'utf8')) as Record<string, unknown>
process.env.APPDATA = mkdtempSync(join(tmpdir(), 'gvs-flow-'))

const { Runtime } = await import('../src/runtime.ts')
const { loadConfig, saveConfig } = await import('../src/lib/config.ts')

const cfg = loadConfig()
Object.assign(cfg, real)
if (process.env.PROBE_HOST) cfg.host = process.env.PROBE_HOST
saveConfig(cfg)

const rt = new Runtime()
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const show = (tag: string) => {
  const s = rt.snapshot
  console.log(
    `${tag.padEnd(16)} scene=${s.scene.padEnd(8)} busy=${String(s.busy).padEnd(5)} rows=${s.rows?.length ?? 0} eps=${s.episodes?.length ?? 0} q=${s.qualities?.length ?? 0} a=${s.audios?.length ?? 0} probeFailed=${s.probeFailed}`,
  )
}
await wait(2500)
show('startup')

// walk the home menu to 榜单, then open it
const items = rt.snapshot.homeItems ?? []
const rankIdx = Math.max(0, items.indexOf('榜单'))
for (let i = 0; i < rankIdx; i++) rt.handleKey('j')
rt.handleKey('enter')
await wait(5000)
show('rank')
if (rt.snapshot.scene !== 'results') {
  console.log(`   status: ${rt.snapshot.status}`)
  rt.close()
  process.exit(1)
}

rt.handleKey('enter')       // open first result
await wait(5000)
show('detail')
console.log('   detail:', JSON.stringify(rt.snapshot.detail))
console.log('   first ep:', JSON.stringify(rt.snapshot.episodes?.[0]))

rt.handleKey('enter')       // 下载本集 → 取画质
for (let i = 0; i < 12; i++) {
  await wait(1000)
  const s = rt.snapshot
  console.log(`   +${i + 1}s scene=${s.scene} busy=${s.busy} q=${s.qualities?.length ?? 0} a=${s.audios?.length ?? 0} probeFailed=${s.probeFailed} | ${s.status}`)
  if (s.scene === 'quality' || (s.probeFailed && !s.busy)) break
}
show('after enter')
console.log('   qualities:', (rt.snapshot.qualities ?? []).slice(0, 5).map((q) => `${q.label} ${q.size}B ${q.width}x${q.height}`).join(' | '))
console.log('   audios:', (rt.snapshot.audios ?? []).map((a) => `${a.label}/${a.lang}${a.isDefault ? '(默认)' : ''}`).join(' | '))

if ((rt.snapshot.audios ?? []).length) {
  rt.handleKey('right')     // 切到音轨
  await wait(200)
  rt.handleKey('j')
  await wait(200)
  console.log(`   switched to tab=${rt.snapshot.optionTab} audioIndex=${rt.snapshot.audioIndex}`)
}
rt.close()
process.exit(0)
