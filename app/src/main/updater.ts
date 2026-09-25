// 从 GitHub Release 自动更新。
//
// 仓库里同时有 TUI 的发布（v0.2.x），electron-updater 的 GitHub provider 只认
// 「Latest release」，会拿到 TUI 的发布。所以这里自己挑出最新的 desktop-v* 发布，
// 再把那个发布的下载目录作为 generic 源交给 electron-updater（读 latest.yml、
// 下载、校验 sha512）。
//
// Windows（NSIS）：自动下载，下载完提示重启安装；不重启则退出时安装。
// macOS：没有代码签名，Squirrel.Mac 不允许自动替换，只提示并打开发布页。
import { app, net, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '@shared/api'
import { runLog } from '@tui/runlog.ts'

const OWNER = 'my-name-is-alan'
const REPO = 'gvs-tui'
const TAG_PREFIX = 'desktop-v'
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

type Release = { tag_name: string; html_url: string; draft: boolean; prerelease: boolean; body?: string }

function newer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return false
}

async function latestDesktopRelease(): Promise<Release | null> {
  const res = await net.fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=50`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'GVS-Desktop' },
  })
  if (!res.ok) throw new Error(`GitHub ${res.status}`)
  const list = (await res.json()) as Release[]
  let best: Release | null = null
  for (const r of list) {
    if (r.draft || r.prerelease || !r.tag_name.startsWith(TAG_PREFIX)) continue
    if (!best || newer(r.tag_name.slice(TAG_PREFIX.length), best.tag_name.slice(TAG_PREFIX.length))) best = r
  }
  return best
}

export class Updater {
  private state: UpdateState = { status: 'idle', version: '', current: app.getVersion(), percent: 0, message: '', url: '', auto: false }
  private timer: NodeJS.Timeout | null = null
  private busy = false

  constructor(private readonly emit: (s: UpdateState) => void) {
    this.state.auto = app.isPackaged && process.platform === 'win32'
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = { info: (m: unknown) => runLog(`updater ${m}`), warn: (m: unknown) => runLog(`updater warn ${m}`), error: (m: unknown) => runLog(`updater error ${m}`), debug: () => {} }
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (i) => this.set({ status: 'ready', version: i.version, percent: 100, message: '' }))
    autoUpdater.on('update-not-available', () => this.set({ status: 'latest', message: '' }))
    autoUpdater.on('error', (e) => this.set({ status: 'error', message: e?.message ?? String(e) }))
  }

  view(): UpdateState {
    return { ...this.state }
  }

  private set(patch: Partial<UpdateState>): void {
    Object.assign(this.state, patch)
    this.emit(this.view())
  }

  start(): void {
    if (!app.isPackaged) return // 开发版不检查
    setTimeout(() => void this.check(false), 15_000)
    this.timer = setInterval(() => void this.check(false), CHECK_EVERY_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async check(manual: boolean): Promise<UpdateState> {
    if (this.busy || this.state.status === 'downloading' || this.state.status === 'ready') return this.view()
    this.busy = true
    this.set({ status: 'checking', message: '' })
    try {
      const rel = await latestDesktopRelease()
      const version = rel ? rel.tag_name.slice(TAG_PREFIX.length) : ''
      if (!rel || !newer(version, this.state.current)) {
        this.set({ status: 'latest', version: version || this.state.current })
        return this.view()
      }
      this.set({ status: 'available', version, url: rel.html_url })
      if (!this.state.auto) {
        if (!app.isPackaged && manual) this.set({ message: '开发版不自动安装' })
        return this.view()
      }
      autoUpdater.setFeedURL({ provider: 'generic', url: `https://github.com/${OWNER}/${REPO}/releases/download/${rel.tag_name}` })
      await autoUpdater.checkForUpdates() // autoDownload=true：发现即下载
    } catch (e) {
      this.set({ status: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      this.busy = false
    }
    return this.view()
  }

  install(): void {
    if (this.state.status === 'ready') {
      setImmediate(() => autoUpdater.quitAndInstall(true, true))
      return
    }
    if (this.state.url) void shell.openExternal(this.state.url)
  }
}
