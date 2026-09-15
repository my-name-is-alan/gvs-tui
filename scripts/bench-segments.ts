// Benchmark + verify the ordered parallel segment puller on a real youku
// playlist. Serial and parallel runs must produce byte-identical files.
//   PROBE_HOST=http://127.0.0.1:8080 bun run scripts/bench-segments.ts [threads] [maxSegs]
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GwClient } from '../src/lib/client.ts'
import { loadConfig } from '../src/lib/config.ts'
import { appendURLs, parseCMAF, referer } from '../src/lib/media.ts'
import { asString, isObj } from '../src/lib/util.ts'

const cfg = loadConfig()
const cli = new GwClient(process.env.PROBE_HOST ?? cfg.host, cfg.key)
const vid = process.env.BENCH_VID ?? 'XMjQ4NDcxODQwOA=='
const threadsList = [Number(process.argv[2] ?? 8)]
const maxSegs = Number(process.argv[3] ?? 40)

const data = await cli.invoke('youku', 'play', { vid, expand: '1', tier: 'multi' }, cli.extra(cfg, 'youku'))
const streams = Array.isArray(data.streams) ? data.streams : []
let playlist = ''
let quality = ''
for (const s of streams) {
  if (!isObj(s)) continue
  if (asString(s.media_type).toLowerCase() === 'audio') continue
  const u = asString(s.playlist_url)
  if (u) {
    playlist = u
    quality = asString(s.stream_type)
    break
  }
}
if (!playlist) throw new Error('没有 playlist_url')
const parsed = await parseCMAF(playlist, referer('youku'))
const segs = (parsed.initURL ? [parsed.initURL, ...parsed.segs] : parsed.segs).slice(0, maxSegs)
console.log(`quality=${quality}  分片=${segs.length}（总共 ${parsed.segs.length + (parsed.initURL ? 1 : 0)}）`)

const dir = mkdtempSync(join(tmpdir(), 'gvs-seg-'))
const human = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`

async function run(threads: number): Promise<{ file: string; secs: number; size: number; hash: string }> {
  const file = join(dir, `segs-${threads}.bin`)
  const started = Date.now()
  await appendURLs(file, segs, referer('youku'), threads)
  const secs = (Date.now() - started) / 1000
  const size = statSync(file).size
  const hash = await new Promise<string>((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
  })
  console.log(`${String(threads).padStart(2)} 路: ${secs.toFixed(2)}s  ${human(size)}  ${human(size / secs)}/s  sha=${hash.slice(0, 16)}`)
  return { file, secs, size, hash }
}

const serial = await run(1)
const results = [serial]
for (const t of threadsList) results.push(await run(t))

const ok = results.every((r) => r.hash === serial.hash)
console.log(ok ? '✓ 顺序与串行完全一致（sha256 相同）' : '✗ 输出与串行不一致，顺序有问题！')

rmSync(dir, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
