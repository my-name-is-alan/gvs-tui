import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { loadConfig } from '../src/lib/config.ts'
import { GwClient } from '../src/lib/client.ts'
import { runTunnel } from '../src/lib/tunnel.ts'
import { parseCMAF, referer, youkuAudioPlaylist, youkuVideoPlaylist } from '../src/lib/media.ts'
const cfg = loadConfig()
const cli = new GwClient(cfg.host, cfg.key)
const abort = new AbortController()
const dir = mkdtempSync(join(tmpdir(), 'gvs-source-timing-'))
const request = () => cli.invoke('youku', 'play', { vid: 'XNjU0OTU0MDc4OA==', expand: '1', tier: 'multi', nocache: '1' }, cli.extra(cfg, 'youku'))
async function play() {
  try { return await request() } catch (e) {
    if (!(e instanceof Error) || !e.message.includes('隧道未连接')) throw e
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tunnel timeout')), 15000)
      runTunnel(cfg.host, cfg.key, (ok, error) => {
        if (ok) { clearTimeout(timer); resolve() }
        else if (error) { clearTimeout(timer); reject(new Error(error)) }
      }, abort.signal)
    })
    return request()
  }
}
try {
  const data = await play()
  for (const [label, url] of [
    ['video', youkuVideoPlaylist(data, 'cmfv5hd4_dolbyvision_hfr_hbr_hq')],
    ['audio', youkuAudioPlaylist(data, '')],
  ]) {
    const pl = await parseCMAF(url!, referer('youku'))
    if (!pl.initURL || !pl.segs.length) throw new Error('Missing init or segments')
    const buffers = []
    for (const src of [pl.initURL, pl.segs[0]!]) {
      const res = await fetch(src, { headers: { Referer: referer('youku') } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      buffers.push(Buffer.from(await res.arrayBuffer()))
    }
    const file = join(dir, `${label}.mp4`)
    writeFileSync(file, Buffer.concat(buffers))
    const output = await new Promise<string>((resolve, reject) => {
      const p = spawn('ffprobe', ['-v', 'trace', '-show_entries', 'stream=start_time,time_base,duration:format=start_time,duration', '-of', 'json', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let info = '', trace = ''
      p.stdout.on('data', b => { info += b })
      p.stderr.on('data', b => { trace += b })
      p.once('error', reject)
      p.once('close', () => resolve(info + '\n' + trace.split('\n').filter(l => /time scale =|duration=|type:'elst'/.test(l)).join('\n')))
    })
    console.log(label, output)
  }
  console.log(`Source samples: ${dir}`)
} finally { abort.abort() }
