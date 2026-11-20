import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, shell, Tray } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import appIconPng from '../../build/icon.png?asset'
import macIconPng from '../../build/icon-mac.png?asset'
import appIconIco from '../../build/icon.ico?asset'
import trayPng16 from '../../build/tray-16.png?asset'
import trayPng32 from '../../build/tray-32.png?asset'
import { trayKey, trayModel } from './tray-model'

// 与 electron-builder.yml 的 appId 保持一致：Windows 按它分组任务栏按钮、找快捷方式图标
const PACKAGED_APP_ID = 'shop.videohack.gvs'
// dev/preview 用独立 AUMID：开始菜单里任何带 shop.videohack.gvs 且指向 electron.exe 的快捷方式（如 Electron.lnk）
// 都会让任务栏按 AUMID 匹配到它并显示 Electron 原子图标，窗口图标/RelaunchIcon 全被忽略。
const APP_ID = app.isPackaged ? PACKAGED_APP_ID : `${PACKAGED_APP_ID}.dev`
// 任务栏按钮图标必须是磁盘上的真实文件（asar 里的路径 shell 读不到）：打包后用 exe 自带图标，dev/preview 用 build/icon.ico
function taskbarIconPath(): string {
  return app.isPackaged ? process.execPath : appIconIco
}
import { DatabaseSync } from 'node:sqlite'
import createEd2kWorker from './ed2k-worker?nodeWorker'
import { HistoryService } from './history-service'
import type { SqlDb } from './history-db'
import { SubscriptionManager } from './subscriptions'
import { fetchCalendar } from './calendar-source'
import { AccountStore } from './account-store'
import { badgesFromQualities, HintQueue, type QualityHint } from '@shared/quality-badges'
import type { Provider } from '@shared/api'
import type { Subscription } from '@shared/api'
import type { GvsApi, JobView, Tone } from '@shared/api'
import { captureProxyEnv, installIQSourceProxy, patchGlobalWebSocket } from './env'
import { Core } from './core'
import { handlePosterProtocol, registerPosterScheme } from './posters'
import { runLog } from '@tui/runlog.ts'
import { Updater } from './updater'
import { userMessage, userFacing } from '@tui/user-message.ts'

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
installIQSourceProxy()
registerPosterScheme()

if (!app.requestSingleInstanceLock()) app.quit()

let win: BrowserWindow | null = null
let quitting = false
let trayHintShown = false

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, userFacing(payload))
}

let stateTimer: NodeJS.Timeout | null = null
let multiSig = ''
const core = new Core({
  state: () => {
    if (stateTimer) return
    stateTimer = setTimeout(() => {
      stateTimer = null
      const st = core.state()
      if (st.configured) {
        accounts.migrate(st.providers)
        // 网关多账号能力（重连 / 换网关后）变了就重新同步当前账号
        const sig = st.providers.filter((p) => core.gatewayMultiAccount(p)).join(',')
        if (sig !== multiSig) { multiSig = sig; accounts.syncGateway() }
        for (const a of st.accounts) accounts.recordStatus(a.provider)
      }
      send('gvs:state', st)
    }, 50)
  },
  jobs: (jobs: JobView[]) => send('gvs:jobs', jobs),
  toast: (message: string, tone: Tone) => send('gvs:toast', { message, tone }),
})

// ---------------------------------------------------------------- 下载历史 / 钩子 / ed2k
let historyRef: HistoryService | null = null
function history(): HistoryService {
  historyRef ??= new HistoryService({
    dir: join(app.getPath('userData'), 'history'),
    openDb: (p) => new DatabaseSync(p) as unknown as SqlDb,
    notify: (t, b) => notify(t, b),
    patchJob: (id, fn) => core.patchJob(id, fn),
    createWorker: (path) => createEd2kWorker({ workerData: { path } }),
    log: runLog,
  })
  return historyRef
}
core.lifecycle = (event, view, task) => {
  if (event === 'start') history().onStart(view, task)
  else history().onComplete(view, task)
}

// ---------------------------------------------------------------- 多账号
const accountsPath = () => join(app.getPath('userData'), 'accounts.json')
const accounts = new AccountStore({
  load: () => (existsSync(accountsPath()) ? readFileSync(accountsPath(), 'utf8') : null),
  save: (json) => {
    const p = accountsPath()
    writeFileSync(p + '.tmp', json)
    renameSync(p + '.tmp', p)
  },
  encrypt: (plain) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain).toString('base64') : null),
  decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, 'base64')),
  importCookie: (p, cookie) => core.importAccountCookie(p, cookie),
  statusOf: (p) => core.state().accounts.find((a) => a.provider === p),
  changed: (view) => send('gvs:accounts', view),
  gateway: {
    supports: (p) => core.gatewayMultiAccount(p),
    ensure: (p, a, name) => core.ensureGatewayAccount(p, a, name),
    rename: (p, a, name) => core.renameGatewayAccount(p, a, name),
    remove: (p, a) => core.deleteGatewayAccount(p, a),
    setActive: (p, a) => core.setGatewayActive(p, a),
    run: (p, a, fn) => core.runAsAccount(p, a, fn),
  },
  log: runLog,
})

/** 探测画质：会员 / 登录类错误时换号重试，并提示 */
function probeWithAccounts(p: Provider, eps: Parameters<typeof core.probe>[1], accountId?: string) {
  return accounts.withFallback(p, () => core.probe(p, eps), (slot) => {
    send('gvs:toast', { message: `当前账号受限，已切换到「${slot.name}」重试`, tone: 'warn' })
  }, accountId)
}

// ---------------------------------------------------------------- 搜索结果画质
const hints = new HintQueue<QualityHint>(async (key, signal) => {
  const i = key.indexOf(':')
  const provider = key.slice(0, i) as Provider
  const id = key.slice(i + 1)
  const d = await core.detail(provider, id, undefined, signal)
  signal.throwIfAborted()
  const ep = d.episodes.find((e) => !e.collection || e.collection === '正片') ?? d.episodes[0]
  if (!ep) throw new Error('no episode')
  const r = await core.probe(provider, [ep], signal)
  core.forgetProbe(r.token)
  return badgesFromQualities(r.qualities, r.audios)
}, { concurrency: 2, timeoutMs: 12_000, ttlMs: 6 * 3600_000, failTtlMs: 30 * 60_000, max: 400 })

// ---------------------------------------------------------------- 订阅
const subsPath = () => join(app.getPath('userData'), 'subscriptions.json')
const subs = new SubscriptionManager({
  detail: (p, id) => core.detail(p, id),
  probe: (p, eps, accountId) => probeWithAccounts(p, eps, accountId),
  enqueue: (req) => core.enqueue(req),
  isDownloaded: (p, vid) => { try { return history().db.hasVid(p, vid) } catch { return false } },
  notify: (title, body, sub) => notify(title, body, sub),
  changed: (view) => {
    send('gvs:subs', view)
    refreshTray()
  },
  load: () => (existsSync(subsPath()) ? readFileSync(subsPath(), 'utf8') : null),
  save: (json) => {
    const p = subsPath()
    writeFileSync(p + '.tmp', json)
    renameSync(p + '.tmp', p)
  },
  log: runLog,
})

function notify(title: string, body: string, sub?: Subscription): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, silent: false, icon: appIconPng })
  n.on('click', () => {
    showMainWindow()
    send('gvs:navigate', { view: 'subscriptions', subId: sub?.id })
  })
  n.show()
}

// ---------------------------------------------------------------- 托盘
// 模块级引用：托盘对象和当前菜单都不能被 GC
let tray: Tray | null = null
let trayMenu: Menu | null = null
let trayMenuKey = ''
function refreshTray(): void {
  if (!tray) return
  const m = trayModel(subs.isPaused(), subs.view())
  tray.setToolTip(m.tooltip)
  const key = trayKey(m)
  if (key === trayMenuKey && trayMenu) return
  trayMenuKey = key
  const act: Record<string, () => void> = {
    open: showMainWindow,
    subs: () => { showMainWindow(); send('gvs:navigate', { view: 'subscriptions' }) },
    pause: () => subs.setPaused(!subs.isPaused()),
    check: () => void subs.checkNow(),
    quit: () => app.quit(),
  }
  trayMenu = Menu.buildFromTemplate(m.items.map((i) => (i.id === 'sep' ? { type: 'separator' as const } : { label: i.label, enabled: i.enabled, click: () => act[i.id]?.() })))
  // Windows：不用 setContextMenu（菜单开着时被替换会吞掉点击），右键时手动弹出当前菜单
  if (process.platform !== 'win32') tray.setContextMenu(trayMenu)
}
function trayImage(): Electron.NativeImage {
  if (process.platform === 'win32') {
    const ico = nativeImage.createFromPath(appIconIco)
    if (!ico.isEmpty()) return ico
  }
  const img = nativeImage.createEmpty()
  img.addRepresentation({ scaleFactor: 1, buffer: nativeImage.createFromPath(trayPng16).toPNG() })
  img.addRepresentation({ scaleFactor: 2, buffer: nativeImage.createFromPath(trayPng32).toPNG() })
  return img
}
function createTray(): void {
  tray = new Tray(trayImage())
  tray.on('click', showMainWindow)
  tray.on('double-click', showMainWindow)
  tray.on('right-click', () => { refreshTray(); if (trayMenu) tray?.popUpContextMenu(trayMenu) })
  refreshTray()
}

const updater = new Updater((u) => {
  send('gvs:update', u)
  if (u.status === 'ready') send('gvs:toast', { message: `新版本 ${u.version} 已下载，重启即可安装`, tone: 'ok' })
})

const api: { [K in keyof GvsApi]: (...args: Parameters<GvsApi[K]>) => unknown } = {
  state: () => core.state(),
  setup: (host, key, proxy) => core.setup(host, key, proxy),
  saveSettings: (patch) => core.saveSettings(patch),
  catalog: (p, country) => core.catalog(p, country),
  browse: (p, s, c) => core.browse(p, s, c),
  tencentDiagnostics: (jobID) => core.tencentDiagnostics(jobID),
  providerSession: (command) => core.providerSession(command),
  crunchyrollSsoLogin: () => core.crunchyrollSsoLogin(),
  parseLink: (t) => core.parseLink(t),
  searchTargets: () => core.searchTargets(),
  searchProvider: (p, q) => core.searchProvider(p, q),
  detail: (p, id, hint) => core.detail(p, id, hint),
  detailFromLink: (l, hint) => core.detailFromLink(l, hint),
  probe: (p, eps, accountId) => probeWithAccounts(p, eps, accountId),
  namingPreview: (r) => core.namingPreview(r),
  tmdbSearch: (t, tv) => core.tmdbSearch(t, tv),
  tmdbSeasons: (id) => core.tmdbSeasons(id),
  enqueue: (r) => (r.accountId ? accounts.use(r.detail.provider, r.accountId, async () => core.enqueue(r)) : core.enqueue(r)),
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
  drmStatus: () => core.drmStatus(),
  deleteDRMOne: (system, id) => core.deleteDRMOne(system, id),
  platformMeta: () => core.platformMeta(),
  uploadDRM: async (system) => {
    const widevine = system === 'widevine'
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [widevine ? { name: 'Widevine 设备文件', extensions: ['wvd'] } : { name: 'PlayReady 设备文件', extensions: ['prd'] }],
    })
    if (r.canceled || !r.filePaths[0]) return null
    return core.uploadDRM(system, r.filePaths[0])
  },
  deleteDRM: (system) => core.deleteDRM(system),
  youkuQrStart: () => core.youkuQrStart(),
  iqcnQrStart: () => core.iqcnQrStart(),
  iqcnQrPoll: () => core.iqcnQrPoll(),
  bilibiliQrStart: () => core.bilibiliQrStart(),
  bilibiliQrPoll: () => core.bilibiliQrPoll(),
  youkuQrPoll: () => core.youkuQrPoll(),
  youkuRenew: () => core.youkuRenew(),
  tencentQrStart: () => core.tencentQrStart(),
  tencentQrPoll: () => core.tencentQrPoll(),
  tencentNativeSmsStart: (phone: string, area?: string) => core.tencentNativeSmsStart(phone, area),
  tencentNativeSmsSubmit: (code: string) => core.tencentNativeSmsSubmit(code),
  qrCancel: () => core.qrCancel(),
  updateState: () => updater.view(),
  checkUpdate: () => updater.check(true),
  installUpdate: () => updater.install(),
  subscriptions: () => subs.view(),
  subscribe: (req) => {
    const sub = subs.subscribe(req)
    void subs.checkNow(sub.id)
    return sub
  },
  updateSubscription: (id, patch) => subs.update(id, patch),
  unsubscribe: (id) => subs.remove(id),
  checkSubscriptions: (id) => subs.checkNow(id),
  setSubscriptionsPaused: (paused) => subs.setPaused(paused),
  setSubscriptionInterval: (minutes) => subs.setInterval(minutes),
  markSubscriptionsSeen: (id) => subs.markSeen(id),
  // 追剧日历：优先网关（provider=dengta 汇总各平台官方排播）；网关没连上才回落到本地芒果直连。
  calendar: async () => {
    const gw = await core.calendar()
    if (gw) return { days: gw, error: '', fetchedAt: Date.now() }
    return fetchCalendar()
  },
  accounts: () => accounts.view(),
  addAccount: async (p, name, cookie) => {
    const r = await accounts.add(p, name, cookie)
    return { id: r.slot.id, needsLogin: r.needsLogin }
  },
  renameAccount: (id, name) => accounts.rename(id, name),
  removeAccount: (id) => accounts.remove(id),
  setDefaultAccount: (id) => accounts.setDefault(id),
  activateAccount: async (id) => ({ needsLogin: (await accounts.activate(id)).needsLogin }),
  updateAccountCookie: async (id, cookie) => { await accounts.updateCookie(id, cookie) },
  qualityHint: (p, id) => hints.get(`${p}:${id}`),
  history: (q) => history().db.list(q),
  historyForShow: (p, id, vids) => history().db.forShow(p, id, vids),
  historyShowCounts: () => history().db.showCounts(),
  removeHistory: (id) => history().db.remove(id),
  computeEd2k: (id, jobId) => history().computeEd2k(id, jobId),
  hookSettings: () => history().hookSettings(),
  saveHookSettings: (s) => history().saveHookSettings(s),
}

ipcMain.handle('gvs:call', async (_e, method: string, args: unknown[]) => {
  const fn = (api as Record<string, (...a: unknown[]) => unknown>)[method]
  if (!fn) return { ok: false, error: '当前客户端暂不支持此操作，请更新后重试。' }
  try {
    return { ok: true, data: userFacing(await fn(...(args ?? []))) }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    runLog(`ipc ${method} failed: ${why}`)
    console.log(`[gvs:call] ${method} failed: ${why}`)
    return { ok: false, error: userMessage(e) }
  }
})

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 1080,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'GVS',
    icon: process.platform === 'win32' ? appIconIco : process.platform === 'darwin' ? macIconPng : appIconPng,
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
  if (process.platform === 'win32') {
    // dev/preview 下进程是 electron.exe，只设 window icon 不够：任务栏会按 AUMID 回退到 exe 图标。
    // setAppDetails 写入窗口级 AppUserModel 属性（含 RelaunchIconResource），任务栏就显示 GVS 图标。
    // RelaunchIconResource/DisplayName 只有在同时设置 RelaunchCommand 时才会被 shell 采用
    const relaunchCommand = [process.execPath, ...process.argv.slice(1)].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
    win.setAppDetails({ appId: APP_ID, appIconPath: taskbarIconPath(), appIconIndex: 0, relaunchCommand, relaunchDisplayName: 'GVS' })
    win.setIcon(nativeImage.createFromPath(appIconIco))
  }
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win?.show()
  })
  // 关窗口 = 收到托盘继续检查订阅；真正退出走托盘菜单「退出」
  win.on('close', (e) => {
    if (quitting || !tray) return
    e.preventDefault()
    win?.hide()
    if (!trayHintShown) {
      trayHintShown = true
      notify('GVS 仍在后台运行', '订阅会继续按时检查；右键托盘图标可以暂停或退出。')
    }
  })
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

function showMainWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

app.on('second-instance', showMainWindow)

app.whenReady().then(() => {
  // macOS 需要编辑菜单，复制/粘贴快捷键才生效；Windows 不要菜单栏。
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }])
      : null,
  )
  handlePosterProtocol()
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID)
  createWindow()
  try {
    createTray()
  } catch (e) {
    runLog(`tray: create failed ${e instanceof Error ? e.message : e}`)
  }
  try { history().migrate(core.jobRecords()) } catch (e) { runLog(`history: open failed ${e instanceof Error ? e.message : e}`) }
  void core.boot().catch(() => {})
  subs.start()
  updater.start()
  app.on('activate', showMainWindow)
})

// Windows 上 Electron 退出不会顺手杀子进程（N_m3u8DL-RE / ffmpeg 会继续占着文件写），
// 所以第一次 before-quit 先拦住退出，等 core 把任务停干净并落盘 jobs.json，再真正退出。
app.on('before-quit', (e) => {
  if (quitting) return
  quitting = true
  e.preventDefault()
  // 用户如果就是不想等就强杀（任务管理器 / cmd 里按 Ctrl+C），别让系统干等。
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => app.exit(0))
  updater.stop()
  subs.stop()
  tray?.destroy()
  tray = null
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
// 有托盘时窗口只是隐藏，不会走到这里；托盘创建失败时保持原来的行为
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) app.quit()
})
