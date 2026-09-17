// Live diagnostic: identical signed segment, Node fetch versus RE proxy modes.
// bun run scripts/check-youku-transport.ts [VID] [STREAM_TYPE]
import { loadConfig } from '../src/lib/config.ts'
import { GwClient } from '../src/lib/client.ts'
import { youkuDRM } from '../src/lib/jobs.ts'
import { youkuVideoPlaylist, referer, hlsKeyArgs, runM3u8dl, cleanRELog } from '../src/lib/media.ts'
import { runTunnel } from '../src/lib/tunnel.ts'
import { ensureM3u8dl, ensureFFmpeg, ensurePackager } from '../src/lib/tools.ts'
import { createHlsRelay } from '../src/lib/hls-relay.ts'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

const [vid = 'XNjU0MjE4NTc2MA==', quality = 'cmfv5hd4_dolbyvision_hfr_hbr_hq'] = process.argv.slice(2)
const dir = mkdtempSync(join(tmpdir(), 'youku-transport-ab-'))
const cfg = loadConfig(), cli = new GwClient(cfg.host, cfg.key), abort = new AbortController()
const ref = referer('youku')
const headers = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
  accept: '*/*', 'accept-language': 'zh-CN,zh;q=0.9', referer: ref,
}
const request = () => cli.invoke('youku', 'play', { vid, expand: '1', tier: 'multi', nocache: '1' }, cli.extra(cfg, 'youku'))
try {
  let data
  try { data = await request() }
  catch (e) {
    if (!(e instanceof Error) || !e.message.includes('隧道未连接')) throw e
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tunnel timeout')), 15000)
      runTunnel(cfg.host, cfg.key, (ok, error) => {
        if (ok) { clearTimeout(timer); resolve() }
        else if (error) { clearTimeout(timer); reject(new Error(error)) }
      }, abort.signal)
    })
    data = await request()
  }
  const drm = youkuDRM(data), url = youkuVideoPlaylist(data, quality)
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error(`Node playlist HTTP ${response.status}`)
  const playlist = await response.text()
  const lines: string[] = []
  for (const line of playlist.split(/\r?\n/)) {
    if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-ENDLIST')) continue
    lines.push(line.startsWith('#')
      ? line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${new URL(uri, response.url || url).href}"`)
      : line.trim() ? new URL(line.trim(), response.url || url).href : '')
    if (line.trim() && !line.startsWith('#')) break
  }
  lines.push('#EXT-X-ENDLIST')
  const source = join(dir, 'sample.m3u8')
  writeFileSync(source, lines.join('\n'))
  const init = /#EXT-X-MAP:.*URI="([^"]+)"/.exec(lines.join('\n'))?.[1]
  if (!init) throw new Error('No init segment')
  const nodeResponse = await fetch(init, { headers, signal: AbortSignal.timeout(20000) })
  const nodeBytes = await nodeResponse.arrayBuffer()
  console.log('NODE', { status: nodeResponse.status, bytes: nodeBytes.byteLength, cdn: new URL(init).hostname })
  for (let i = 0; i < 3; i++) {
    const check = await fetch(init, { headers, signal: AbortSignal.timeout(20000) })
    console.log('NODE repeat', i, check.status, (await check.arrayBuffer()).byteLength)
  }
  const bin = await ensureM3u8dl(), ff = await ensureFFmpeg(), pack = await ensurePackager()
  // Freeze the same playlist for all cases; re-fetching the gateway playlist
  // can issue different signed segment URLs and invalidates the comparison.
  const frozen = createServer((_req, res) => res.end(lines.join('\n')))
  await new Promise<void>(resolve => frozen.listen(0, '127.0.0.1', resolve))
  const frozenAddress = frozen.address() as { port: number }
  const relay = await createHlsRelay(`http://127.0.0.1:${frozenAddress.port}/sample.m3u8`, headers, !!drm.reKey)
  const cases: Array<[string, string[]]> = [
    ['re-node-relay', ['--use-system-proxy', 'false']],
    ['re-node-headers-first', ['--use-system-proxy', 'false',
      ...Object.entries(headers).filter(([k]) => k !== 'referer').flatMap(([k, v]) => ['--header', `${k}: ${v}`])]],
    ['re-direct', ['--use-system-proxy', 'false']],
    ['re-default', []],
    ['re-direct-node-headers', ['--use-system-proxy', 'false',
      ...Object.entries(headers).filter(([k]) => k !== 'referer').flatMap(([k, v]) => ['--header', `${k}: ${v}`])]],
  ]
  try { for (const [label, extra] of cases) {
    const work = join(dir, label)
    mkdirSync(work)
    const log = join(work, 're.log'), started = Date.now()
    const check = await fetch(init, { headers, signal: AbortSignal.timeout(20000) })
    console.log('NODE before', label, check.status, (await check.arrayBuffer()).byteLength)
    try {
      const result = await runM3u8dl(bin, [label === 're-node-relay' ? relay.url : source, '--custom-range', '0-0', '--save-dir', work, '--tmp-dir', work, '--save-name', 'sample',
        '--select-video', 'best', '--binary-merge', '--del-after-done', 'false', '--no-ansi-color', '--force-ansi-console',
        '--disable-update-check', '--log-file-path', log, '--download-retry-count', '0', '--http-request-timeout', '15',
        '--thread-count', '1', '--ffmpeg-binary-path', ff, '--header', `referer: ${ref}`, ...hlsKeyArgs(drm.reKey),
        '--decryption-engine', 'SHAKA_PACKAGER', '--decryption-binary-path', pack, ...extra], log)
      const files = readdirSync(work).filter(n => n.endsWith('.mp4')).map(n => ({ name: n, bytes: statSync(join(work, n)).size }))
      console.log(label, { ok: files.length > 0, files, seconds: (Date.now() - started) / 1000 })
      if (!files.length) console.log(cleanRELog(result).slice(-1000))
    } catch (e) {
      console.log(label, { error: cleanRELog(e instanceof Error ? e.message : String(e)).slice(-900), seconds: (Date.now() - started) / 1000 })
    }
  } } finally { await relay.close(); frozen.closeAllConnections(); frozen.close() }
  console.log(`Fixture: ${dir}`)
} finally { abort.abort() }
