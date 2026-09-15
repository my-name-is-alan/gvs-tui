// 音轨分片完整性：串行下载 vs 并发下载，各自能否被 ffmpeg 完整解码？
//   PROBE_HOST=http://127.0.0.1:8080 bun run scripts/check-audio-integrity.ts [vid]
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GwClient } from '../src/lib/client.ts'
import { loadConfig } from '../src/lib/config.ts'
import { appendURLs, referer, youkuAudioURLs } from '../src/lib/media.ts'
import { lookFFmpeg } from '../src/lib/ffmpeg.ts'
import { asString } from '../src/lib/util.ts'

const ffmpeg = lookFFmpeg('ffmpeg')
if (!ffmpeg) throw new Error('no ffmpeg')
const cfg = loadConfig()
const cli = new GwClient(process.env.PROBE_HOST ?? cfg.host, cfg.key)
const vid = process.argv[2] ?? 'XMjQ4NDcxODQwOA=='

const data = await cli.invoke('youku', 'play', { vid, expand: '1', tier: 'multi' }, process.env.PROBE_SIGN === '1' ? cli.extra(cfg, 'youku') : undefined)
const urls = await youkuAudioURLs(data, '')
console.log(`音频分片: ${urls.length} 段（含 init）`)
if (!urls.length) {
  console.log('取不到音频分片')
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'gvs-audio-'))

function decodeErrors(file: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d: Buffer) => { err += d.toString() })
    child.on('error', () => resolve(-1))
    child.on('close', () => resolve(err.split('\n').filter((l) => l.trim()).length))
  })
}

const hash = (f: string) => new Promise<string>((resolve, reject) => {
  const h = createHash('sha256')
  createReadStream(f).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
})

for (const threads of [1, 4]) {
  const file = join(dir, `audio-${threads}.fmp4`)
  const t0 = Date.now()
  await appendURLs(file, urls, referer('youku'), threads)
  const secs = (Date.now() - t0) / 1000
  const size = statSync(file).size
  const errs = await decodeErrors(file)
  const sha = await hash(file)
  console.log(
    `${threads} 并发: ${secs.toFixed(1)}s  ${(size / 1048576).toFixed(1)} MB  解码错误行=${errs}  sha=${sha.slice(0, 16)}`,
  )
}

// 对照：只取前 3 段（init + 两段），看最小可解码单元是否正常
const small = join(dir, 'audio-small.fmp4')
await appendURLs(small, urls.slice(0, 3), referer('youku'), 1)
console.log(`前 3 段: 解码错误行=${await decodeErrors(small)}`)

const first = asString((urls[0] ?? '').slice(0, 70))
console.log(`init url: ${first}`)
rmSync(dir, { recursive: true, force: true })
process.exit(0)
