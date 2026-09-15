// Measure the parallel downloader against a real CDN link.
//   PROBE_HOST=http://127.0.0.1:8080 bun run scripts/bench-download.ts [threads...]
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GwClient } from '../src/lib/client.ts'
import { loadConfig } from '../src/lib/config.ts'
import { downloadProgress, pickHongguo, referer } from '../src/lib/media.ts'

const cfg = loadConfig()
const cli = new GwClient(process.env.PROBE_HOST ?? cfg.host, cfg.key)
const vid = process.env.BENCH_VID ?? '7679474102679112766'

const data = await cli.invoke('hongguo', 'resolve', { vid, platform: 'ios' })
const picked = pickHongguo(data, vid, '1080p')
if (!picked.cdn) throw new Error('红果没有直链')
console.log(`URL host: ${new URL(picked.cdn).host}`)

const runs = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0)
const threadsList = runs.length ? runs : [1, 4, 8]
const dir = mkdtempSync(join(tmpdir(), 'gvs-bench-'))
const human = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`

for (const threads of threadsList) {
  const dest = join(dir, `out-${threads}.bin`)
  for (const f of [dest, `${dest}.part0`, `${dest}.part1`, `${dest}.part2`, `${dest}.part3`, `${dest}.part4`, `${dest}.part5`, `${dest}.part6`, `${dest}.part7`]) {
    rmSync(f, { force: true })
  }
  const started = Date.now()
  let last = started
  let lastBytes = 0
  let peak = 0
  await downloadProgress(
    picked.cdn,
    dest,
    referer('hongguo'),
    (n) => {
      const now = Date.now()
      if (now - last >= 500) {
        peak = Math.max(peak, ((n - lastBytes) * 1000) / (now - last))
        last = now
        lastBytes = n
      }
    },
    undefined,
    threads,
  )
  const secs = (Date.now() - started) / 1000
  const size = statSync(dest).size
  console.log(
    `${String(threads).padStart(2)} 路: ${secs.toFixed(1)}s  ${human(size)}  平均 ${human(size / secs)}/s  峰值 ${human(peak)}/s`,
  )
}

rmSync(dir, { recursive: true, force: true })
process.exit(0)
