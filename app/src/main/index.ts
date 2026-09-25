import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { join } from 'node:path'
import type { GvsApi, JobView, Tone } from '@shared/api'
import { captureProxyEnv, patchGlobalWebSocket } from './env'
import { Core } from './core'
import { handlePosterProtocol, registerPosterScheme } from './posters'
import { Updater } from './updater'

captureProxyEnv()
patchGlobalWebSocket()
registerPosterScheme()

// 开发调试：独立 profile，不和已安装的 GVS 抢单实例锁
if (process.env.GVS_PROFILE_DIR) app.setPath('userData', process.env.GVS_PROFILE_DIR)

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
  parseLink: (t) => core.parseLink(t),
  searchTargets: () => core.searchTargets(),
  searchProvider: (p, q) => core.searchProvider(p, q),
  detail: (p, id) => core.detail(p, id),
  detailFromLink: (l) => core.detailFromLink(l),
  probe: (p, eps) => core.probe(p, eps),
  namingPreview: (r) => core.namingPreview(r),
  tmdbSearch: (t, tv) => core.tmdbSearch(t, tv),
  enqueue: (r) => core.enqueue(r),
  jobs: () => core.jobList(),
  retryJob: (id) => core.retryJob(id),
  clearFinished: () => core.clearFinished(),
  openPath: async (p) => {
    const err = await shell.openPath(p || core.outDir())
    if (err) throw new Error(err)
  },
  showItem: (p) => shell.showItemInFolder(p),
  chooseDir: async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], defaultPath: core.outDir() })
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

app.on('before-quit', () => {
  updater.stop()
  core.shutdown()
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
