// 端到端验证：真实 mobile42 下载 → 随进度上报（report_type=download）→ 再取流查风控。
//
// 用法（先启动网关：GVS_TX_DOWNLOAD_REPORT=1 + TENCENT_APP_SYNC_SNAPSHOT，并保持
// 手机 App 在线 + 快照采集器 watch 模式）：
//   TX_MOBILE_CTX=<appsync ctx json> TX_UPTIME_SEC=$(adb shell cat /proc/uptime | cut -d' ' -f1) \
//   bun run scripts/check-tencent-download-report.ts
//
// 语义红线：所有上报值来自 downloadTencentMobile42 的真实逐段回调（done/total/bytes），
// 节流用与 runtime.ts / core.ts 相同的 nextTencentDownloadReport 共享纯函数。
import { readFileSync, mkdtempSync, rmSync, writeFileSync, statSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GwClient } from '../src/lib/client.ts'
import { loadConfig } from '../src/lib/config.ts'
import { runTunnel } from '../src/lib/tunnel.ts'
import { nextTencentDownloadReport, type TxDownloadReportState } from '../src/lib/tencent-download-report.ts'

const cfg = loadConfig()
const host = process.env.PROBE_HOST ?? cfg.host
const key = process.env.PROBE_KEY ?? cfg.key
if (!key) throw new Error('没有网关 Key')
const cli = new GwClient(host, key, () => cfg)

// 隧道：腾讯/优酷等出网走本机 IP（网关 egress 通过 TUI 隧道回连本机）。
// 必须等 OPEN 才能 play；结束前 abort。
const tunnelAbort = new AbortController()
let tunnelOpen = false
runTunnel(host, key, (ok, err) => {
  if (ok && !tunnelOpen) { tunnelOpen = true; console.log('[tunnel] OPEN') }
  else if (!ok && err) console.log('[tunnel] down:', err)
}, tunnelAbort.signal)

const VID = process.env.TX_VID ?? 'c410321r8hs'
const DEFN = process.env.TX_DEFN ?? 'suhd'
const CTX_PATH = process.env.TX_MOBILE_CTX ?? ''
const uptimeSec = Number(process.env.TX_UPTIME_SEC ?? '0')
const baseUptimeNs = Number.isFinite(uptimeSec) && uptimeSec > 0 ? Math.round(uptimeSec * 1e9) : 0

const ctxText = CTX_PATH ? readFileSync(CTX_PATH, 'utf8') : ''
const baseMobile = JSON.parse(ctxText) as Record<string, any>

function playInput(extraUptimeNs: number): Record<string, unknown> {
  const m = structuredClone(baseMobile)
  m.Scene.VID = VID
  m.Scene.Defn = DEFN
  if (baseUptimeNs > 0) m.Scene.UptimeNanos = baseUptimeNs + extraUptimeNs
  m.Scene.FlowID = ''
  return { protocol: 'mobile42', session_type: 'app', account_source: 'app_sync', vid: VID, defn: DEFN, mobile: JSON.stringify(m) }
}

const reportState: TxDownloadReportState = { seq: new Map(), last: new Map() }
let reportErr = 0
function send(obs: ReturnType<typeof nextTencentDownloadReport>): void {
  if (!obs) return
  void cli.invoke('tencent', 'report', { report_type: 'download', observation: JSON.stringify(obs) })
    .then((r) => console.log(`[report] ${obs.segments}/${obs.total_segs} seq=${obs.seq} bytes=${obs.bytes} → ${JSON.stringify(r).slice(0, 220)}`))
    .catch((e) => { reportErr += 1; console.error(`[report ERR] ${e instanceof Error ? e.message : String(e)}`) })
}

/** 清单 URL（当前响应为明文 TS；SDD 时走 TUI mobile42 解码路径，本驱动只做真实下载+上报）。 */
function manifestURLs(data: Record<string, unknown>): string[] {
  const man = String(data.manifest ?? '')
  return man.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
}

async function orderedDownloadAll(urls: string[], dest: string, progress: (bytes: number, index: number, total: number) => void): Promise<void> {
  let totalBytes = 0
  for (let i = 0; i < urls.length; i++) {
    const res = await fetch(urls[i]!)
    if (!res.ok) throw new Error(`segment ${i} http ${res.status}`)
    const ab = await res.arrayBuffer()
    appendFileSync(dest, new Uint8Array(ab))
    totalBytes += ab.byteLength
    progress(totalBytes, i + 1, urls.length)
  }
}

const started = Date.now()
const work = mkdtempSync(join(tmpdir(), 'tx-e2e-'))
const dest = join(work, 'e08.ts')
try {
  // 0) 等隧道 OPEN
  for (let i = 0; i < 30 && !tunnelOpen; i++) await new Promise((r) => setTimeout(r, 1000))
  if (!tunnelOpen) throw new Error('隧道未打开')

  // 1) 取流（真实 play，快照模式）
  const play0 = await cli.invoke('tencent', 'play', playInput(0))
  const urls0 = manifestURLs(play0)
  console.log('[play#1]', JSON.stringify({
    code: play0.code, protocol: play0.protocol, duration: play0.duration,
    urls: urls0.length, video_status: play0.video_status, exem: play0.exem,
  }))
  if (!urls0.length) throw new Error(`play 没有分段 code=${play0.code}`)

  // 2) 真实下载全部分段（明文 TS，逐段落盘，进度 = 真实 bytes/segments）
  await orderedDownloadAll(urls0, dest, (bytes, index, total) => {
    send(nextTencentDownloadReport(reportState, VID, '', { err: '', txSegs: { done: index, total, bytes } }))
  })
  console.log(`[download] done, bytes=${(statSync(dest).size / 1048576).toFixed(1)}MB`)

  // 3) 完成事件（done=total 必发）
  send(nextTencentDownloadReport(reportState, VID, DEFN, { done: true, err: '' }))

  // 4) 同会话再取流，查风控
  const play1 = await cli.invoke('tencent', 'play', playInput((Date.now() - started) * 1e6))
  const urls1 = manifestURLs(play1)
  console.log('[play#2]', JSON.stringify({
    code: play1.code,
    urls: urls1.length,
    duration: play1.duration,
    video_status: play1.video_status, exem: play1.exem,
    drm_method: (play1.drm as any)?.method,
  }))
  console.log('[verdict] reportErr=' + reportErr, 'play2Code=' + play1.code, 'play2Segs=' + urls1.length, 'exem=' + play1.exem)
} finally {
  tunnelAbort.abort()
  rmSync(work, { recursive: true, force: true })
}
