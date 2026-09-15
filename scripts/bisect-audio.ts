// 二分定位：音轨从头拼到第 N 段时，解码错误从哪一段开始出现。
//   PROBE_HOST=http://127.0.0.1:8080 bun run scripts/bisect-audio.ts [vid]
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GwClient } from '../src/lib/client.ts'
import { loadConfig } from '../src/lib/config.ts'
import { appendURLs, referer, youkuAudioURLs } from '../src/lib/media.ts'
import { lookFFmpeg } from '../src/lib/ffmpeg.ts'

const ffmpeg = lookFFmpeg('ffmpeg')
if (!ffmpeg) throw new Error('no ffmpeg')
const cfg = loadConfig()
const cli = new GwClient(process.env.PROBE_HOST ?? cfg.host, cfg.key)
const vid = process.argv[2] ?? 'XMjQ4NDcxODQwOA=='
const data = await cli.invoke('youku', 'play', { vid, expand: '1', tier: 'multi' }, process.env.PROBE_SIGN === '1' ? cli.extra(cfg, 'youku') : undefined)
const urls = await youkuAudioURLs(data, '')
const dir = mkdtempSync(join(tmpdir(), 'gvs-bisect-'))

function decodeErrors(file: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d: Buffer) => { err += d.toString() })
    child.on('error', (e) => resolve(`spawn error ${e.message}`))
    child.on('close', () => resolve(err.split('\n').filter((l) => l.trim())[0] ?? '（无错误）'))
  })
}

// 逐段单独测（init + 单段），找出坏的那几段
console.log(`共 ${urls.length} 段（含 init）`)
const bad: number[] = []
for (let i = 1; i < Math.min(urls.length, 24); i++) {
  const f = join(dir, `one-${i}.mp4`)
  await appendURLs(f, [urls[0]!, urls[i]!], referer('youku'), 1)
  const err = await decodeErrors(f)
  if (err !== '（无错误）') bad.push(i)
  console.log(`  init+seg${String(i).padStart(3, '0')}: ${(statSync(f).size / 1024).toFixed(0)} KB  ${err.slice(0, 80)}`)
}
console.log(bad.length ? `前 24 段里坏段: ${bad.join(',')}` : '前 24 段都能单独解码')

// 连续拼 N 段
for (const n of [3, 9, 33]) {
  const f = join(dir, `head-${n}.mp4`)
  await appendURLs(f, urls.slice(0, n), referer('youku'), 1)
  console.log(`前 ${n} 段: ${(statSync(f).size / 1048576).toFixed(1)} MB  ${(await decodeErrors(f)).slice(0, 80)}`)
}
rmSync(dir, { recursive: true, force: true })
process.exit(0)
