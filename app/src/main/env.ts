// 进程级网络环境，必须在任何 tui/lib 模块发请求前执行。
//
// TUI 的约定：网关走代理（被墙/屏蔽 CN 时靠 Clash），CDN 和优酷/腾讯上游
// 必须直连（家宽 IP）。Bun 版靠去掉代理环境变量后重启自身实现；这里：
//   - 记下代理地址，仅供隧道 WebSocket 使用；
//   - 删掉 HTTP(S)_PROXY，子进程（ffmpeg / N_m3u8DL-RE）和 Node fetch 都直连；
//   - 网关 HTTP 走 net.fetch（见 shims/proxy.ts），天然跟随系统代理。
import { session } from 'electron'
import { dirname, join } from 'node:path'
import { HttpsProxyAgent } from 'https-proxy-agent'
import WsSocket from 'ws'
import { configPath } from '@tui/config.ts'
import { isProxyEnvKey } from './shims/proxy'

let envProxy = ''

export function captureProxyEnv(): void {
  for (const [k, v] of Object.entries(process.env)) {
    if (!isProxyEnvKey(k)) continue
    if (!envProxy && v?.trim()) envProxy = v.trim()
    delete process.env[k]
  }
  process.env.GVS_TUI_LOG_PATH ||= join(dirname(configPath()), 'desktop-run.log')
  // 从访达启动的 macOS 应用拿不到 shell 的 PATH，Homebrew 装的 ffmpeg / MP4Box 会找不到。
  if (process.platform === 'darwin') {
    const have = (process.env.PATH ?? '').split(':')
    const extra = ['/opt/homebrew/bin', '/usr/local/bin'].filter((d) => !have.includes(d))
    if (extra.length) process.env.PATH = [...extra, ...have].filter(Boolean).join(':')
  }
}

/** 系统代理（PAC / 手动）或环境变量里的 HTTP 代理，给隧道 WebSocket 用。 */
async function proxyFor(url: string): Promise<string> {
  if (envProxy) return envProxy
  try {
    const rule = await session.defaultSession.resolveProxy(url)
    const m = /^(?:PROXY|HTTPS)\s+([^\s;]+)/i.exec(rule.trim())
    if (m) return `http://${m[1]}`
  } catch {
    /* direct */
  }
  return ''
}

let agentFor: (url: string) => HttpsProxyAgent<string> | undefined = () => undefined

export async function installTunnelWebSocket(gatewayHost: string): Promise<void> {
  let host = ''
  try {
    host = new URL(gatewayHost).hostname
  } catch {
    host = ''
  }
  const local = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  const proxy = local ? '' : await proxyFor(gatewayHost)
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined
  agentFor = () => agent
}

/** tunnel.ts 用 `new WebSocket(url, { headers })`（Bun 语义）。换成 ws 实现并挂代理。 */
class TunnelWebSocket extends WsSocket {
  constructor(url: string | URL, opts?: { headers?: Record<string, string> }) {
    const target = String(url)
    super(target, { headers: opts?.headers, agent: agentFor(target) })
  }
}

export function patchGlobalWebSocket(): void {
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = TunnelWebSocket
}
