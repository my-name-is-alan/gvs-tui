import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { join } from 'node:path'
import type { GvsApi, JobView, Tone } from '@shared/api'
import { captureProxyEnv, patchGlobalWebSocket } from './env'
import { Core } from './core'
import { handlePosterProtocol, registerPosterScheme } from './posters'
import { runLog } from '@tui/runlog.ts'
import { Updater } from './updater'

// 开发调试：独立 profile，不和已安装的 GVS 抢单实例锁。
// 同时把 configPath() 依赖的 APPDATA 也指过去（它在每次调用时读环境变量），
// 这样冒烟运行不会碰到真实的 tui.json / 日志。
// 必须在任何 configPath() 调用之前——captureProxyEnv() 就会写日志路径。
if (process.env.GVS_PROFILE_DIR) {
  app.setPath('userData', process.env.GVS_PROFILE_DIR)
  process.env.APPDATA = process.env.GVS_PROFILE_DIR
}
process.env.GVS_VERSION_RECORDS_PATH ||= join(app.getPath('userData'), 'actual-versions.jsonl')

captureProxyEnv()
patchGlobalWebSocket()
registerPosterScheme()

if (!app.requestSingleInstanceLock()) app.quit()

let win: BrowserWindow | null = null

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

let stateTimer: NodeJS.Timeout | null = null
const core = new Core({
  state: () => {
    if (stateTimer) return
    stateTimer = setTimeout(() => {
      stateTimer = null
      send('gvs:state', core.state())
    }, 50)
  },
  jobs: (jobs: JobView[]) => send('gvs:jobs', jobs),
  toast: (message: string, tone: Tone) => send('gvs:toast', { message, tone }),
})

const updater = new Updater((u) => {
  send('gvs:update', u)
  if (u.status === 'ready') send('gvs:toast', { message: `新版本 ${u.version} 已下载，重启即可安装`, tone: 'ok' })
})

const api: { [K in keyof GvsApi]: (...args: Parameters<GvsApi[K]>) => unknown } = {
  state: () => core.state(),
  setup: (host, key) => core.setup(host, key),
  saveSettings: (patch) => core.saveSettings(patch),
  catalog: (p) => core.catalog(p),
  browse: (p, s, c) => core.browse(p, s, c),
  tencentDiagnostics: (jobID) => core.tencentDiagnostics(jobID),
  providerSession: (command) => core.providerSession(command),
  parseLink: (t) => core.parseLink(t),
  searchTargets: () => core.searchTargets(),
  searchProvider: (p, q) => core.searchProvider(p, q),
  detail: (p, id, hint) => core.detail(p, id, hint),
  detailFromLink: (l, hint) => core.detailFromLink(l, hint),
  probe: (p, eps) => core.probe(p, eps),
  namingPreview: (r) => core.namingPreview(r),
  tmdbSearch: (t, tv) => core.tmdbSearch(t, tv),
  enqueue: (r) => core.enqueue(r),
  jobs: () => core.jobList(),
  retryJob: (id) => core.retryJob(id),
  pauseJob: (id) => core.pauseJob(id),
  resumeJob: (id) => core.resumeJob(id),
  removeJob: (id, deleteFiles) => core.removeJob(id, deleteFiles),
  pauseAll: () => core.pauseAll(),
  resumeAll: () => core.resumeAll(),
  clearFinished: () => core.clearFinished(),
  cacheInfo: () => core.cacheInfo(),
  clearCache: () => core.clearCache(),
  openPath: async (p) => {
    const err = await shell.openPath(p || core.outDir())
    if (err) throw new Error(err)
  },
  showItem: (p) => shell.showItemInFolder(p),
  chooseDir: async (start) => {
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: (start || '').trim() || core.outDir(),
    })
    return r.canceled ? '' : (r.filePaths[0] ?? '')
  },
  youkuQrStart: () => core.youkuQrStart(),
  youkuQrPoll: () => core.youkuQrPoll(),
  youkuRenew: () => core.youkuRenew(),
  tencentQrStart: () => core.tencentQrStart(),
  tencentQrPoll: () => core.tencentQrPoll(),
  qrCancel: () => core.qrCancel(),
  updateState: () => updater.view(),
  checkUpdate: () => updater.check(true),
  installUpdate: () => updater.install(),
}

ipcMain.handle('gvs:call', async (_e, method: string, args: unknown[]) => {
  const fn = (api as Record<string, (...a: unknown[]) => unknown>)[method]
  if (!fn) return { ok: false, error: `unknown method ${method}` }
  try {
    return { ok: true, data: await fn(...(args ?? [])) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

function createWindow(): void {
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'GVS',
    backgroundColor: '#f4f2ec',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  const devURL = process.env.ELECTRON_RENDERER_URL
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:') && !(devURL && url.startsWith(devURL))) e.preventDefault()
  })
  if (devURL) void win.loadURL(devURL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

app.whenReady().then(() => {
  // macOS 需要编辑菜单，复制/粘贴快捷键才生效；Windows 不要菜单栏。
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }])
      : null,
  )
  handlePosterProtocol()
  createWindow()
  void core.boot().catch(() => {})
  updater.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Windows 上 Electron 退出不会顺手杀子进程（N_m3u8DL-RE / ffmpeg 会继续占着文件写），
// 所以第一次 before-quit 先拦住退出，等 core 把任务停干净并落盘 jobs.json，再真正退出。
let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  quitting = true
  e.preventDefault()
  // 用户如果就是不想等就强杀（任务管理器 / cmd 里按 Ctrl+C），别让系统干等。
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => app.exit(0))
  updater.stop()
  void (async () => {
    try {
      await core.shutdown()
    } catch (e) {
      runLog(`quit: shutdown failed ${e instanceof Error ? e.message : e}`)
    }
    core.dispose()
    // 这条日志是排查「关不掉 / 关了还有子进程」的第一个抓手。
    runLog('quit: shutdown done')
    app.quit()
  })()
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
