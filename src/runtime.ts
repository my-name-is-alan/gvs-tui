import QRCode from 'qrcode'
import { ProviderSessions, type SessionCommand } from './lib/provider-session.ts'
import { manifestDetail } from './lib/manifest-detail.ts'
import { providerLink } from './lib/manifest-provider.ts'
import { readTencentDiagnostics, tencentDiagnosticPath } from './lib/tencent-diagnostics.ts'
import { PROVIDER_IDS, supportsSearch, isManifestProvider } from './lib/providers.ts'
import { needsTunnel } from './lib/tunnel-policy.ts'
import { parseEpisodes as parseEps, episodeCollections } from './lib/episodes.ts'
import { parseSeriesTitle, seriesSeason } from './lib/series-title.ts'
import { startTencentDualQR, pollTencentQR, pollTencentDualQR, applyTencentLogin, tencentLabels, tencentPlayInput, type TencentMode } from './lib/tencent-qr.ts'
import { fetchTencentAccount, txAccountSummary, type TxAccount } from './lib/tencent-account.ts'
import { Discovery, discoveryRows } from './lib/discovery'
import { Navigation, moveCursor, moveJobCursor } from './lib/navigation'
import { DownloadDraft } from './lib/download-draft'
import { gridWindow } from './lib/grid'
import { clip, wrapLines } from './lib/text'
import { demoSnapshot } from './lib/demo'
import { demoInvoke } from './lib/discovery-demo'
import { appendFileSync, readFileSync } from 'node:fs'
import { join as pathJoin } from 'node:path'
import {
  clampThreads,
  loadConfig,
  normalizeOutDir,
  saveConfig,
  type FileConfig,
} from './lib/config.ts'
import { GwClient, ReloginRequired, type KeyInfo } from './lib/client.ts'
import { selectAudioTracks } from './lib/audio-selection.ts'
import { normalizeHttpProxy } from './lib/proxy.ts'
import {
  JobHub,
  bindYoukuAudioTracksToTask,
  jobTitle,
  jobNaming,
  nextJobID,
  patchJob,
  type DlTask,
} from './lib/jobs.ts'
import { moviePlayables, probeOptions, qualityChoiceLabel, youkuEditionsFromDetail, youkuMoviePick, tencentPlayQualityInput} from './lib/quality.ts'
import { selectedTencentQuality } from './lib/tencent-quality-selection.ts'
import { runTunnel } from './lib/tunnel.ts'
import {
  hostIsLocal,
  pollYoukuQR,
  startYoukuQR,
} from './lib/youku-qr.ts'
import {
  accountSummary,
  loginSummary,
  parseYkAccount,
  ykAccount,
  ykLoginInfo,
  ykRefresh,
  shouldRefreshYouku,
  type YkAccount,
  type YkLogin,
} from './lib/youku-session.ts'
import { normalizeTmdbProxy, tmdbSearch } from './lib/tmdb.ts'
import { mediaKindFromMetadata, movieEdition, type TitleKind } from './lib/media-kind.ts'
import { clipTitle, extractDouyinURL, extractTencentLinks, extractYoukuVideoId } from './lib/link.ts'
import { pickDouyinURL, pickURL, tencentPlayProbeOk } from './lib/media.ts'
import {
  installRunLogProcessHooks,
  runLog,
  runLogPath,
  runLogScene,
  runLogStartup,
  setRunLogDisabled,
} from './lib/runlog.ts'
import { filename, folder, dots, tierHeight } from './lib/name.ts'
import { confirmationLines, episodeRanges, settingGroup, settingInfoLines, viewMetrics, HELP_LINES } from './lib/ui-layout.ts'
import { JOB_PAGE_SIZE } from './lib/view.ts'
import { anyInt, asBool, asString, firstStr, isObj } from './lib/util.ts'
import { ensureTools } from './lib/tools.ts'
import type {
  Audio,
  Detail,
  Episode,
  Job,
  OptionTab,
  Quality,
  Row,
  Scene,
  Snapshot,
  StatusKind,
  TMDBHit,
  VipProbe,
} from './types.ts'

const ALL_PROVIDERS = PROVIDER_IDS

/** 网关说「这个签名我不认识」的几种说法。 */
const SIGN_DEAD_RE = /not found|revoked|invalid Yk-Sign|yk_sign not found/i

/**
 * Temporary diagnostic: `GVS_TRACE=<file>` appends a line per event, which is
 * the only way to see what a full-screen TUI is doing from the outside.
 */
function trace(line: string): void {
  const file = process.env.GVS_TRACE
  if (!file) return
  try {
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // never let tracing break the app
  }
}

type Listener = (s: Snapshot) => void

export class Runtime {
  private readonly providerSessions = new ProviderSessions((p,a,input) => { if (!this.cli) throw new Error('请先连接网关'); return this.cli.invoke(p,a,input) })
  private mewatchQR = false
  private providerLoginBusy = false
  private providerLoginGeneration = 0
  private cfg: FileConfig
  private cli: GwClient | null = null
  private keyInfo: KeyInfo | null = null
  snapshot!: Snapshot
  private scene: Scene
  private status = ''
  /** Lets the shell color a message instead of guessing from its text. */
  private statusKind: StatusKind = 'info'
  /** Only a tunnel warning may be replaced by a recovery notification. */
  private statusSource?: 'tunnel'
  /** Set while a gateway call is in flight, so the UI can show progress. */
  private busy = false
  private workCount = 0
  private cursor = 0
  private provIdx = 0
  private qIdx = 0
  private setIdx = 0
  private hostInput: string
  private keyInput: string
  private query = ''
  private editField = ''
  private editValue = ''
  private hostFocused = true
  private keyFocused = false
  private rows: Row[] = []
  /** 最后一个列表请求，用于翻页；more/cursor 来自网关返回。 */
  private listSpec: {
    provider: string
    action: string
    input: Record<string, unknown>
  } | null = null
  private listCursor = ''
  private listMore = false
  private eps: Episode[] = []
  private episodeCatalog: Episode[] = []
  private episodeGroup = ''
  private qualities: Quality[] = []
  private audios: Audio[] = []
  private audioIdx = 0
  private optionTab: OptionTab = 'quality'
  private probeFailed = false
  private detailInfo: Detail | null = null
  /** 网关侧优酷登录态（按 Yk-Sign 维度）。 */
  private ykLogin: YkLogin | null = null
  /** 账号与会员真实状态（account/profile）。 */
  private ykAcct: YkAccount | null = null
  private txAcct: TxAccount | null = null
  /** 最近一次取流带回来的权益真相（play 的 quality_gate）。 */
  private vipProbe: VipProbe | null = null
  /** 本机 Yk-Sign 已不在网关凭证库里（cred info 报 not found/revoked/invalid）。 */
  private signMissing = false
  private tmdbHits: TMDBHit[] = []
  private tmdbState: NonNullable<Snapshot['tmdbState']> = 'idle'
  private tmdbError = ''
  private tmdbGeneration = 0
  private jobs: Job[] = []
  private readonly logs = new Map<number, string[]>()
  private readonly draft = new DownloadDraft()
  private get pending() {
    return this.draft.tasks
  }
  private set pending(tasks: DlTask[]) {
    this.draft.set(tasks)
  }
  private readonly navigation = new Navigation()
  private readonly discovery: Discovery
  private viewport = { width: 100, height: 30 }
  private filterIndex = 0
  private logOffset = 0
  private contentOffset = 0
  private detailExpanded = false
  private settingsExpanded = false
  private requestGeneration = 0
  private searching = false
  private pageLoading = false
  private readonly simulated: boolean
  private detailCursor = 0
  private selectAnchor = 0
  private detailTitle = ''
  private detailId = ''
  private detailProv = ''
  private qrAscii = ''
  private qrPngPaths: string[] = []
  private qrTencent: TencentMode | null = null
  /** When true, qr scene polls App+TV in parallel. */
  private qrTencentDual = false
  private qrDualDone = { app: false, tv: false }
  private qrHint = '用优酷 App 扫码登录'
  private qrTicket = ''
  private qrLoginToken = ''
  private qrPolls = 0
  private tunnelOk = false
  private tunnelErr = ''
  private tunnelTransport: 'ws' | 'legacy' | undefined
  private tunnelOn = false
  private youkuEnsure: Promise<void> | null = null
  private readonly hub: JobHub
  private readonly listeners = new Set<Listener>()
  private readonly abort = new AbortController()
  private tunnelAbort: AbortController | null = null
  private qrTimer: NodeJS.Timeout | null = null
  private qrBusy = false

  constructor(options: { simulate?: boolean } = {}) {
    this.simulated = !!options.simulate
    this.cfg = this.simulated
      ? {
          host: 'http://demo.local',
          key: '',
          outDir: './downloads',
          releaseGroup: 'Demo',
          tmdbKey: '',
          tmdbLang: 'zh-CN',
          youkuSign: '',
          tencentCookie: '',
          douyinCookie: '',
          hongguoMerge: true,
          hongguoNfo: true,
          hongguoFmt: 'mkv',
          huangguoNfo: true,
          huangguoFmt: 'mkv',
          threads: 4,
          tmpDir: '',
        }
      : loadConfig()
    this.discovery = new Discovery(
      (p, a, input) => this.cli!.invoke(p, a, input),
      () => this.emit(),
    )
    this.hostInput = this.cfg.host
    this.keyInput = this.cfg.key
    this.hub = new JobHub((e) => {
      patchJob(this.jobs, e)
      const line = [e.status, e.err || e.log, e.done ? e.note : ''].filter(Boolean).join(' · ')
      const history = this.logs.get(e.id) ?? []
      if (line && history.at(-1) !== line) {
        history.push(line)
        this.logs.set(e.id, history.slice(-1000))
      }
      this.emit()
    })
    if (!this.cfg.key.trim()) {
      this.scene = 'setup'
    } else {
      this.cli = new GwClient(this.cfg.host, this.cfg.key, () => this.cfg)
      this.scene = 'home'
    }
    if (this.simulated) {
      this.cli = new GwClient(this.cfg.host, this.cfg.key, () => this.cfg)
      this.cli.invoke = demoInvoke
      this.keyInfo = {
        id: 'demo',
        name: '演示账户',
        prefix: 'demo',
        scope: [],
        all: true,
        qps: 20,
        daily: 0,
        usedToday: 0,
        expiresAt: null,
        permanent: true,
        daysLeft: null,
      }
      this.scene = 'workspace'
    }
    this.snapshot = this.build()
    if (this.simulated) {
      setRunLogDisabled(true)
      void this.discovery.open('youku')
    } else {
      this.bootRunLog()
      void this.boot()
    }
  }

  private bootRunLog(): void {
    setRunLogDisabled(false)
    installRunLogProcessHooks()
    let git = ''
    try {
      const r = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], {
        cwd: import.meta.dir,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (r.exitCode === 0) git = r.stdout.toString().trim()
    } catch {
      /* packaged builds have no .git */
    }
    let version = ''
    try {
      const pkg = JSON.parse(readFileSync(pathJoin(import.meta.dir, '..', 'package.json'), 'utf8')) as {
        version?: string
      }
      version = pkg.version || ''
    } catch {
      /* ignore */
    }
    runLogStartup({
      host: this.cfg.host,
      version: version || undefined,
      git: git || undefined,
      scene: this.scene,
    })
  }

  onSnapshot(fn: Listener): () => void {
    this.listeners.add(fn)
    fn(this.snapshot)
    return () => this.listeners.delete(fn)
  }

  set(field: string, value: string): void {
    if (field === 'query') {
      this.query = value
      this.requestGeneration++
      this.searching = false
    } else if (field === 'host') {
      this.hostInput = value
      this.cfg.host = value.replace(/\/+$/, '').trim()
    } else if (field === 'key') this.keyInput = value
    else if (field === 'edit') this.editValue = value
    this.emit()
  }

  handleKey(
    name: string,
    mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
  ): void {
    if (mods.ctrl && name.toLowerCase() === 'c') {
      this.close()
      return
    }
    const k = normKey(name, mods.shift)
    // Alt/⌥ or Ctrl+1..7. Bare 1-7 is workspace-only (see updateWorkspace).
    if ((mods.alt || mods.ctrl) && ['1', '2', '3', '4', '5', '6', '7'].includes(k)) {
      this.switchPlatform(Number(k) - 1)
      this.emit()
      return
    }
    if (['f1', 'f2', 'f3', 'f4'].includes(k)) {
      if (this.scene === 'setup' && k !== 'f1') return
      this.requestGeneration++
      this.searching = false
      this.discovery.invalidate()
      const next = (
        { f1: 'help', f2: 'search', f3: 'jobs', f4: 'settings' } as const
      )[k as 'f1']
      if (this.scene !== next) {
        this.pushNavigation(this.scene, this.cursor)
        this.scene = next
        this.cursor = 0
      }
      this.emit()
      return
    }
    if (
      k === 'esc' &&
      ['help', 'jobs', 'settings', 'results'].includes(this.scene) && !this.settingsExpanded
    ) {
      this.back()
      this.emit()
      return
    }
    switch (this.scene) {
      case 'setup':
        this.updateSetup(k)
        break
      case 'home':
        this.scene = 'workspace'
        void this.discovery.open(this.providers()[0] ?? 'youku')
        break
      case 'workspace':
        this.updateWorkspace(k, mods.shift)
        break
      case 'filters':
        this.updateFilters(k)
        break
      case 'confirm':
        if (k === 'esc') {
          this.scene = 'quality'
        } else if (k === 'enter') {
          const tasks = this.draft.take()
          if (tasks.length) this.enqueueAll(tasks)
        } else if (k === 'o') {
          this.editField = '确认下载目录'
          this.editValue = this.cfg.outDir
          this.scene = 'edit'
        } else {
          const total = confirmationLines(this.confirmation(), this.viewport.width - 2).length
          const room = viewMetrics(this.viewport.width, this.viewport.height).scrollRoom
          this.contentOffset = moveCursor(this.contentOffset, k, Math.max(1, total - room + 1), room)
        }
        break
      case 'help':
        this.cursor = moveCursor(
          this.cursor,
          k,
          Math.max(1, HELP_LINES.length - viewMetrics(this.viewport.width, this.viewport.height).bodyHeight + 1),
          viewMetrics(this.viewport.width, this.viewport.height).bodyHeight,
        )
        break
      case 'job-detail':
        if (k === 'esc') {
          this.scene = 'jobs'
        } else {
          const room = viewMetrics(this.viewport.width, this.viewport.height).jobLogRows
          this.logOffset = moveCursor(
            this.logOffset,
            k,
            Math.max(1, this.jobLines().length - 2 - room + 1),
            room,
          )
        }
        break
      case 'search':
        this.updateSearch(k, mods.shift)
        break
      case 'results':
        this.updateResults(k)
        break
      case 'detail':
        this.updateDetail(k, mods.shift)
        break
      case 'quality':
        this.updateQuality(k)
        break
      case 'tmdb':
        this.updateTMDB(k)
        break
      case 'jobs':
        if (k === 'enter' && this.jobs[this.cursor]) {
          this.scene = 'job-detail'
          this.logOffset = 0
        } else
          this.cursor = moveJobCursor(this.cursor, k, this.jobs.length, JOB_PAGE_SIZE)
        break
      case 'settings':
        this.updateSettings(k)
        break
      case 'qr':
        if (k === 'esc') {
          this.cancelQRScene()
          this.scene = 'settings'
        } else if (k === 'enter' || k === ' ') {
          void this.pollQR()
        }
        break
      case 'edit':
        this.updateEdit(k)
        break
    }
    this.emit()
  }

  close(): void {
    this.stopQR()
    this.discovery.invalidate()
    this.requestGeneration++
    this.tunnelAbort?.abort()
    this.abort.abort()
  }

  private lastLoggedScene: Scene | '' = ''
  private emit(): void {
    if (this.scene !== this.lastLoggedScene) {
      this.contentOffset = 0
      this.settingsExpanded = false
      if (this.scene === 'detail') this.detailExpanded = false
    }
    if (this.lastLoggedScene && this.lastLoggedScene !== this.scene) {
      runLogScene(this.lastLoggedScene, this.scene)
    }
    this.lastLoggedScene = this.scene
    this.snapshot = this.build()
    for (const fn of this.listeners) fn(this.snapshot)
    trace(
      `emit scene=${this.scene} busy=${this.busy} tunnel=${this.tunnelOk} status=${this.status}`,
    )
  }

  /** Update the status line and how the shell should read it. */
  private say(message: string, kind: StatusKind = 'info', source?: 'tunnel'): void {
    this.status = message
    this.statusKind = kind
    this.statusSource = source
  }

  /**
   * Run a gateway round trip with the busy flag up, so the shell can show a
   * spinner instead of a frozen frame.
   */
  private async work<T>(run: () => Promise<T>): Promise<T> {
    this.workCount++
    this.busy = true
    this.emit()
    try {
      return await run()
    } finally {
      this.workCount--
      this.busy = this.workCount > 0
      this.emit()
    }
  }

  private providers(): string[] {
    if (!this.keyInfo || !this.cli) return []
    const out = ALL_PROVIDERS.filter((p) =>
      this.cli!.allows(this.keyInfo!.scope, this.keyInfo!.all, p),
    )
    return out
  }

  private has(p: string): boolean {
    if (!this.keyInfo || !this.cli) return false
    return this.cli.allows(this.keyInfo.scope, this.keyInfo.all, p)
  }

  private homeItems(): string[] {
    const items: string[] = []
    if (this.has('douyin') || this.has('youku') || this.has('tencent')) items.push('粘贴链接')
    items.push('搜索')
    if (this.has('hongguo') || this.has('huangguo') || this.has('youku') || this.has('tencent'))
      items.push('榜单')
    items.push('任务', '设置')
    return items
  }

  private settingFields(): string[] {
    const f = ['隧道', '网关', '网关代理', 'Key', '下载目录', '下载线程']
    if (this.has('youku') || this.has('tencent') || this.has('hongguo') || this.has('huangguo'))
      f.push('发布组')
    if (this.has('youku') || this.has('tencent')) f.push('TMDB Key', 'TMDB 代理')
    if (this.has('youku')) f.push('优酷扫码', '优酷登录')
    if (this.has('tencent')) f.push('腾讯双扫码', '腾讯 Cookie', '腾讯登录')
    if (this.has('tencent')) {
      f.push('腾讯 caption=all', '腾讯探测原画', '腾讯 encode=all')
    }
    if (this.has('hongguo')) f.push('红果合并', '红果 NFO', '红果封装')
    if (this.has('huangguo')) f.push('黄果 NFO', '黄果封装')
    if (this.has('douyin')) f.push('抖音 Cookie')
    if (this.has('mewatch')) f.push('mewatch 激活', 'mewatch 检查授权', 'mewatch 状态', 'mewatch profiles', 'mewatch profile', 'mewatch 退出')
    if (this.has('hamivideo')) f.push('Hami 会话类型', 'Hami TV Cookie', 'Hami TV 续期', 'Hami Web 准备', 'Hami 手机号（确认发码）', 'Hami 短信码', 'Hami 状态', 'Hami 退出')
    if (this.has('tencent')) f.push('腾讯观测绑定', '腾讯诊断日志')
    f.push('运行日志')
    return f
  }

  private settingValue(f: string): string {
    if (f === 'Hami 会话类型') return this.cfg.hamiClient || 'tv'
    if (f === '腾讯观测绑定') return this.cfg.tencentObservations ? '开 · 本地观测不等于腾讯已接收' : '关 · 风险诊断仍本地记录'
    if (f === '腾讯诊断日志') return tencentDiagnosticPath()
    if (f.startsWith('Hami ') || f.startsWith('mewatch ')) return '回车操作 · 账号材料不保存到本机配置'
    if ((Object.values(tencentLabels) as string[]).includes(f)) return '独立扫码 · 不覆盖其他 Cookie'
    if (f === '腾讯双扫码') return '默认 · App + 极光 TV 同时出码并轮询'
    if (f === '腾讯登录') return this.txAcct ? txAccountSummary(this.txAcct) : '回车刷新账号信息'
    if (f === '腾讯 TV 设备 ID') return this.cfg.tencentTVDevice ? '已配置' : '未配置'
    if (f === '腾讯 TV QUA') return this.cfg.tencentTVQUA ? '已配置' : '未配置'
    if (f === '腾讯 TV 版本') return this.cfg.tencentTVVersion || '未配置'

    switch (f) {
      case '隧道':
        if (this.tunnelOk) {
          const via =
            this.tunnelTransport === 'legacy'
              ? '旧协议 · 走 CDN 会被掐'
              : 'WebSocket'
          return `已连接 · 优酷/腾讯/黄果走本机 IP · ${via}`
        }
        if (this.tunnelErr) return `断开  ${this.tunnelErr}`
        return '未连接'
      case '网关':
        return this.cfg.host
      case '网关代理': {
        const override = process.env.GVS_PROXY?.trim()
        const proxy = override || this.cfg.gatewayProxy
        if (!proxy) return '默认网络 · 回车配置代理'
        try { return `${new URL(proxy).origin} · ${override ? '启动环境覆盖' : '已保存'}` }
        catch { return '地址格式无效 · 回车修改' }
      }
      case 'Key':
        if (this.simulated) return '演示模式，无需 Key'
        return this.cfg.key.length > 12
          ? `${this.cfg.key.slice(0, 12)}…`
          : this.cfg.key
      case '下载目录':
        return this.cfg.outDir
      case '下载线程':
        return `${this.cfg.threads} 路并发`
      case '发布组':
        return this.cfg.releaseGroup || '未设'
      case 'TMDB Key':
        return this.cfg.tmdbKey ? '已配置' : '未配置'
      case 'TMDB 代理':
        if (!this.cfg.tmdbProxy) return '默认网络 · 回车配置独立代理'
        try { return `${new URL(this.cfg.tmdbProxy).origin} · 仅 TMDB` }
        catch { return '地址格式无效 · 回车修改' }
      case '优酷扫码':
        return '仅支持扫码登录（不再提供 Cookie 导入）'
      case '优酷登录':
        if (!this.cfg.youkuSign) return '未登录 · 回车扫码'
        if (this.signMissing) return '本机签名已不在网关凭证库 · 回车重新扫码'
        return this.ykAcct
          ? accountSummary(this.ykAcct, this.vipProbe ?? undefined)
          : this.ykLogin
            ? loginSummary(this.ykLogin)
            : '检查中…（回车刷新）'
      case '腾讯 Cookie':
        return this.cfg.tencentCookie ? '已保存' : '空 · 回车粘贴'
      case '抖音 Cookie':
        return this.cfg.douyinCookie ? '已保存 · 搜索可用' : '空 · 回车粘贴（搜索需要 sessionid）'
      case '腾讯 caption=all':
        return this.cfg.tencentCaptionAll ? '开（软+硬字幕）' : '关（默认 soft）'
      case '腾讯探测原画':
        return this.cfg.tencentProbeSource ? '开（source=1）' : '关（默认）'
      case '腾讯 encode=all':
        return this.cfg.tencentEncodeAll ? '开（风控敏感）' : '关（默认）'
      case '红果合并':
        return this.cfg.hongguoMerge ? '开' : '关'
      case '红果 NFO':
        return this.cfg.hongguoNfo ? '开' : '关'
      case '红果封装':
        return this.cfg.hongguoFmt
      case '黄果 NFO':
        return this.cfg.huangguoNfo ? '开' : '关'
      case '黄果封装':
        return this.cfg.huangguoFmt
      case '运行日志':
        return runLogPath()
      default:
        return ''
    }
  }

  private editSeed(f: string): string {
    if (f === '腾讯 TV 设备 ID') return this.cfg.tencentTVDevice || ''
    if (f === '腾讯 TV QUA') return this.cfg.tencentTVQUA || ''
    if (f === '腾讯 TV 版本') return this.cfg.tencentTVVersion || ''

    switch (f) {
      case '网关代理':
        return this.cfg.gatewayProxy || ''
      case '网关':
        return this.cfg.host
      case 'Key':
        return this.cfg.key
      case '下载目录':
        return this.cfg.outDir
      case '下载线程':
        return String(this.cfg.threads)
      case '发布组':
        return this.cfg.releaseGroup
      case 'TMDB Key':
        return this.cfg.tmdbKey
      case 'TMDB 代理':
        return this.cfg.tmdbProxy || ''
      case '腾讯 Cookie':
        return this.cfg.tencentCookie
      case '抖音 Cookie':
        return this.cfg.douyinCookie ?? ''
      default:
        return ''
    }
  }

  private build(): Snapshot {
    const cursor =
      this.scene === 'quality'
        ? this.qIdx
        : this.scene === 'settings'
          ? this.setIdx
          : this.cursor
    return {
      scene: this.scene,
      workspace: {
        ...this.discovery.view,
        rows: [...this.discovery.view.rows],
      },
      simulated: this.simulated,
      confirmation: this.scene === 'confirm' ? this.confirmation() : undefined,
      contentOffset: this.contentOffset,
      detailExpanded: this.detailExpanded,
      settingsExpanded: this.settingsExpanded,
      jobDetailLines: this.jobLines(),
      logOffset: this.logOffset,
      host: this.cfg.host,
      status: this.status,
      statusKind: this.statusKind,
      busy: this.busy || this.discovery.view.loading,
      tunnelOk: this.tunnelOk,
      tunnelError: this.tunnelErr || undefined,
      tunnelTransport: this.tunnelTransport,
      ykLogin: this.ykLogin
        ? {
            ok: this.ykLogin.ok,
            summary: loginSummary(this.ykLogin),
            refreshable: this.ykLogin.refreshable,
          }
        : undefined,
      ykAccount: this.ykAcct
        ? {
            loggedIn: this.ykAcct.loggedIn,
            needsScan: this.ykAcct.needsScan,
            nick: this.ykAcct.nick,
            uid: this.ykAcct.uid,
            method: this.ykAcct.method,
            vipSource: this.ykAcct.vipSource,
            isVip: this.ykAcct.isVip,
            vipUntil: this.ykAcct.vipUntil,
            riskLevel: this.ykAcct.riskLevel,
            summary: accountSummary(this.ykAcct, this.vipProbe ?? undefined),
          }
        : undefined,
      vipProbe: this.vipProbe ?? undefined,
      cursor:
        this.scene === 'workspace'
          ? this.discovery.view.cursor
          : this.scene === 'filters'
            ? this.filterIndex
            : cursor,
      providerIndex: this.provIdx,
      qualityIndex: this.qIdx,
      audioIndex: this.audioIdx,
      optionTab: this.optionTab,
      providers: this.providers(),
      homeItems: this.homeItems(),
      rows: this.rows,
      listMore: this.listMore,
      episodes: this.eps.map((e) => ({ ...e })),
      episodeGroups: episodeCollections(this.episodeCatalog),
      episodeGroup: this.episodeGroup,
      qualities: this.qualities,
      audios: this.audios.map((a) => ({ ...a })),
      tmdbHits: this.tmdbHits,
      tmdbState: this.tmdbState === 'loading' && this.tmdbGeneration !== this.requestGeneration ? 'idle' : this.tmdbState,
      tmdbError: this.tmdbError,
      // Publish immutable rows so Vue recomputes both the list and the selected detail pane on every event.
      jobs: this.jobs.map((job) => ({ ...job })),
      settings: this.settingFields().map((label) => ({
        label,
        value: this.settingValue(label),
      })),
      detail: this.detailInfo ?? undefined,
      detailTitle: this.detailTitle,
      detailProvider: this.detailProv || undefined,
      pendingCount: this.pending.length,
      pendingEpisodes: this.pending.map((t) => t.episode),
      probeFailed: this.probeFailed,
      query: this.query,
      hostInput: this.hostInput,
      hostFocused: this.hostFocused,
      keyFocused: this.keyFocused,
      keyConfigured: Boolean(this.cfg.key.trim()),
      editField: this.editField,
      editValue: this.editValue,
      qrAscii: this.qrAscii,
      qrPngPaths: this.qrPngPaths,
      qrHint: this.qrHint,
    }
  }

  /**
   * 启动时的优酷自检：先看本地凭证，再让网关续期（**不需要扫码**），最后查账号。
   *
   * 这里刻意不发任何「会话过期」的结论 —— 会员那几个 mtop 接口要网页 Cookie，
   * 扫码登录后必然报 SESSION_EXPIRED，那是「查不到会员」，不是掉登录。
   * 真正掉登录只有 `refresh` 说 `needs_relogin`，或者 `play` 报 ReloginRequired。
   */
  private async ensureYouku(): Promise<void> {
    if (!this.cli || !this.cfg.youkuSign) return
    try {
      this.ykLogin = await ykLoginInfo(this.cli, this.cfg.youkuSign)
    } catch {
      // cred info 失败不影响后面
    }
    // `cred info` 是唯一会校验签名的只读接口：签名不在网关凭证库里时它直接报
    // not found / revoked。这时候 `account` 还能从全局会话答出来（所以你看到
    // 「已登录」），但 play/download 一律报 invalid Yk-Sign。
    this.signMissing =
      !this.ykLogin?.ok && SIGN_DEAD_RE.test(this.ykLogin?.hint ?? '')
    if (this.signMissing) {
      this.say(
        '本机 Yk-Sign 在网关凭证库里已经不在了（网关重启/重新部署常见）→ 设置 → 优酷扫码 重新登录',
        'warn',
      )
    }
    if (shouldRefreshYouku(this.ykLogin) && !this.signMissing) {
      try {
        const res = await ykRefresh(this.cli, this.cfg.youkuSign)
        if (res.needsRelogin) {
          this.say(
            `优酷登录态需要重新扫码：设置 → 优酷扫码（${res.hint || '网关续期被拒'}）`,
            'warn',
          )
        } else if (res.refreshed) {
          this.ykLogin = await ykLoginInfo(this.cli, this.cfg.youkuSign)
        }
      } catch (e) {
        trace(`yk refresh failed: ${e instanceof Error ? e.message : e}`)
      }
    }
    await this.checkYoukuAccount()
  }

  /** 合并启动、隧道恢复和登录成功触发的重复账户检查。 */
  private queueEnsureYouku(): void {
    if (!this.cli || !this.cfg.youkuSign || this.youkuEnsure) return
    this.youkuEnsure = this.ensureYouku().finally(() => {
      this.youkuEnsure = null
    })
  }

  /** 查账号与会员状态（会打几个上游接口，只在启动和手动刷新时调）。 */
  private async checkYoukuAccount(): Promise<void> {
    if (!this.cli || !this.cfg.youkuSign) return
    this.ykAcct = await ykAccount(this.cli, this.cfg.youkuSign)
    // 签名不在库里 → 账号接口很可能答的是网关自己的全局会话，不能当本机登录态。
    if (this.signMissing) this.ykAcct.needsScan = true
    if (this.ykAcct.needsScan && !this.signMissing) {
      this.say(
        '优酷登录态不可用：设置 → 优酷扫码 重新登录（否则 VIP 片源只能看试看段）',
        'warn',
      )
    }
    this.emit()
  }
  /** 查网关侧优酷登录态；失败不影响其它流程。 */
  private async checkYoukuLogin(): Promise<void> {
    if (!this.cli || !this.cfg.youkuSign) return
    this.ykLogin = await ykLoginInfo(this.cli, this.cfg.youkuSign)
    this.emit()
  }

  /**
   * 续期优酷登录态。网关能用 stoken/ptoken 自己续，**不需要重新扫码**；
   * 只有它明确说 needs_relogin 时才真的要扫码。
   */
  private async renewYoukuLogin(): Promise<boolean> {
    if (!this.cli || !this.cfg.youkuSign) return false
    try {
      const res = await this.work(() =>
        ykRefresh(this.cli!, this.cfg.youkuSign),
      )
      this.ykLogin = await ykLoginInfo(this.cli, this.cfg.youkuSign)
      if (res.needsRelogin) {
        this.say(
          `优酷登录态需要重新扫码：${res.hint || '设置 → 优酷扫码'}`,
          'warn',
        )
        this.emit()
        return false
      }
      this.say(
        res.refreshed ? '优酷登录态已续期' : '优酷登录态正常，无需续期',
        'ok',
      )
      this.emit()
      return true
    } catch (e) {
      this.say(`优酷续期失败：${e instanceof Error ? e.message : e}`, 'err')
      this.emit()
      return false
    }
  }

  private async boot(): Promise<void> {
    await this.ensureBins()
    if (this.scene === 'home') {
      await this.refreshKey()
      if (this.scene === 'home') {
        this.scene = 'workspace'
        const p = this.providers().find((p) => p !== 'douyin')
        if (p) {
          this.provIdx = this.providers().indexOf(p)
          await this.discovery.open(p)
        } else this.say('当前 Key 没有可浏览的平台', 'warn')
        this.emit()
      }
    }
  }

  private async ensureBins(): Promise<void> {
    try {
      await ensureTools((s) => {
        this.say(s)
        this.emit()
      }, this.abort.signal)
    } catch (e) {
      this.say(`工具缺失：${e instanceof Error ? e.message : e}`, 'warn')
      this.emit()
    }
  }

  private async refreshKey(): Promise<void> {
    if (!this.cli) return
    await this.work(async () => {
      try {
        this.keyInfo = await this.cli!.keyInfo()
        this.say(
          `${this.keyInfo.name}  scope=${this.keyInfo.all ? '全部' : this.keyInfo.scope.join(',')}  ${
            this.keyInfo.permanent || !this.keyInfo.expiresAt
              ? '永不到期'
              : `剩 ${this.keyInfo.daysLeft ?? 0} 天`
          }`,
          'ok',
        )
        if (!this.tunnelOn && needsTunnel(p => this.has(p))) {
          this.openTunnel()
        } else if (this.tunnelOk) {
          this.queueEnsureYouku()
        }
      } catch (e) {
        this.say(`Key 无效：${e instanceof Error ? e.message : e}`, 'err')
        this.scene = 'setup'
        this.hostFocused = false
        this.keyFocused = true
      }
    })
  }

  private tunnelProxy(): string {
    return (process.env.GVS_PROXY?.trim() || this.cfg.gatewayProxy || '').replace(/\/$/, '')
  }

  private restartTunnel(): void {
    if (!this.cli || !needsTunnel(p => this.has(p))) return
    this.tunnelAbort?.abort()
    this.tunnelOn = false
    this.tunnelOk = false
    this.openTunnel()
  }

  private openTunnel(): void {
    this.tunnelOn = true
    const tunnelAbort = new AbortController()
    this.tunnelAbort = tunnelAbort
    // Announce each outage once. Recovery replaces its warning immediately,
    // but leaves any newer operation message alone.
    let announcedDrop = false
    runTunnel(
      this.cfg.host,
      this.cfg.key,
      (ok, err, transport) => {
        if (this.abort.signal.aborted || tunnelAbort.signal.aborted) return
        const wasUp = this.tunnelOk
        this.tunnelOk = ok
        this.tunnelErr = err
        if (transport) this.tunnelTransport = transport
        if (ok) {
          if (this.statusSource === 'tunnel')
            this.say('隧道已恢复：优酷/腾讯/黄果走本机 IP', 'ok')
          announcedDrop = false
          // account/profile 必须走当前 Key 自己的隧道；等 OPEN 后再查。
          if (!wasUp) this.queueEnsureYouku()
        } else {
          if (!announcedDrop) {
            announcedDrop = true
            this.say(
              err === 'closed'
                ? '隧道断开，自动重连中（优酷/腾讯/黄果暂时无法取链）'
                : `隧道断开 ${err}`,
              'warn',
              'tunnel',
            )
          }
        }
        this.emit()
      },
      tunnelAbort.signal,
      () => this.tunnelProxy(),
    )
  }

  private updateSetup(k: string): void {
    if (k === 'tab') {
      this.hostFocused = !this.hostFocused
      this.keyFocused = !this.keyFocused
      return
    }
    if (k !== 'enter') return
    this.cfg.host = this.hostInput.replace(/\/+$/, '').trim()
    this.cfg.key = this.keyInput.trim()
    if (!this.cfg.key) {
      this.say('请填写 API Key', 'warn')
      return
    }
    this.persistConfig()
    this.cli = new GwClient(this.cfg.host, this.cfg.key, () => this.cfg)
    this.scene = 'home'
    void this.refreshKey().then(() => {
      if (this.scene === 'home') {
        this.scene = 'workspace'
        const p = this.providers().find((p) => p !== 'douyin')
        if (p) {
          this.provIdx = this.providers().indexOf(p)
          void this.discovery.open(p)
        }
        this.emit()
      }
    })
  }

  resize(width: number, height: number) {
    this.viewport = { width, height }
    this.emit()
  }
  private pushNavigation(scene: Scene, cursor: number) {
    this.navigation.push(
      scene,
      scene === 'workspace'
        ? this.discovery.view.cursor
        : scene === 'settings'
          ? this.setIdx
          : cursor,
      {
        rows: this.rows,
        listSpec: this.listSpec,
        listCursor: this.listCursor,
        listMore: this.listMore,
        query: this.query,
        draft: {
          tasks: this.pending.map((t) => ({ ...t })),
          qualities: this.qualities,
          audios: this.audios,
          qIdx: this.qIdx,
          audioIdx: this.audioIdx,
          optionTab: this.optionTab,
        },
        detail: {
          eps: this.eps,
          catalog: this.episodeCatalog,
          group: this.episodeGroup,
          info: this.detailInfo,
          title: this.detailTitle,
          id: this.detailId,
          provider: this.detailProv,
          cursor: this.detailCursor,
        },
      },
    )
  }
  private back() {
    this.requestGeneration++
    this.searching = false
    this.pageLoading = false
    this.discovery.invalidate()
    const prev = this.navigation.pop()
    this.scene = prev.scene
    this.cursor = prev.cursor
    if (prev.payload) {
      const p = prev.payload as {
        rows: Row[]
        listSpec: {
          provider: string
          action: string
          input: Record<string, unknown>
        } | null
        listCursor: string
        listMore: boolean
        query: string
        draft?: {
          tasks: DlTask[]
          qualities: Quality[]
          audios: Audio[]
          qIdx: number
          audioIdx: number
          optionTab: OptionTab
        }
        detail?: {
          eps: Episode[]
          catalog?: Episode[]
          group?: string
          info: Detail | null
          title: string
          id: string
          provider: string
          cursor: number
        }
      }
      this.rows = p.rows
      this.listSpec = p.listSpec
      this.listCursor = p.listCursor
      this.listMore = p.listMore
      this.query = p.query
      if (p.draft && ['quality', 'tmdb', 'confirm'].includes(prev.scene)) {
        this.pending = p.draft.tasks
        this.qualities = p.draft.qualities
        this.audios = p.draft.audios
        this.qIdx = p.draft.qIdx
        this.audioIdx = p.draft.audioIdx
        this.optionTab = p.draft.optionTab
      }
      if (
        p.detail &&
        ['detail', 'quality', 'tmdb', 'confirm'].includes(prev.scene)
      ) {
        this.eps = p.detail.eps
        this.episodeCatalog = p.detail.catalog ?? []
        this.episodeGroup = p.detail.group ?? ''
        this.detailInfo = p.detail.info
        this.detailTitle = p.detail.title
        this.detailId = p.detail.id
        this.detailProv = p.detail.provider
        this.detailCursor = p.detail.cursor
      }
    }
    if (this.scene === 'settings') this.setIdx = prev.cursor
    if (
      this.scene === 'workspace' &&
      !this.discovery.view.rows.length &&
      this.providers().includes(this.discovery.view.provider)
    )
      void this.discovery.load()
  }
  private jobLines() {
    const job = this.jobs[this.cursor]
    const title = wrapLines(job?.title || '', this.viewport.width - 2)
    return job
      ? [
          clip(job.title, this.viewport.width - 2),
          `状态 ${job.status} · ${Math.round(job.pct * 100)}%`,
          ...readTencentDiagnostics(this.cfg.host + String.fromCharCode(0) + this.cfg.key, String(job.id), 20).map(e => `[腾讯诊断] ${e.at} ${e.action}/${e.phase} ${e.status} → ${e.decision}${e.code ? ' code=' + e.code : ''}`),
          // The fixed heading is two rows; long titles remain readable in the log.
          ...(title.length > 1 ? [...title, ''] : []),
          ...(job.err ? wrapLines(`失败阶段：${job.phase || '未知'} · ${job.err}`, this.viewport.width - 2) : []),
          ...wrapLines(
            this.logs.get(job.id)?.join('\n') ||
              [job.err, job.log].filter(Boolean).join('\n') ||
              '暂无日志',
            this.viewport.width - 2,
          ),
        ]
      : []
  }
  private confirmation() {
    const first = this.pending[0]
    const naming = first ? jobNaming(first, this.cfg) : undefined
    return {
      title: first?.series || first?.title || this.detailTitle,
      kind: naming?.kind,
      year: first?.year,
      episodes: first?.kind === 'movie'
        ? this.pending.map(t => t.edition || '正片').join('、')
        : episodeRanges(this.pending.map(t => t.episode || 1)),
      quality: (this.qualities[this.qIdx] ? qualityChoiceLabel(this.qualities[this.qIdx]!) : '') || first?.quality || '平台提供的单一视频流',
      audio: this.audios.filter(a => a.selected)
        .map(a => [a.lang !== '—' ? a.lang : '', a.label].filter(Boolean).join(' ')).join(' / ') || '平台默认',
      directory: naming && first?.provider !== 'douyin' ? folder(naming, this.cfg.outDir) : this.cfg.outDir,
      name: naming ? filename(naming) : '',
    }
  }
  private switchPlatform(slot: number): void {
    const p = ['youku', 'tencent', 'hongguo', 'huangguo', 'douyin'][slot]
    if (!p) return
    if (!this.has(p)) {
      this.say('当前 Key 没有这个平台权限', 'warn')
      return
    }
    this.requestGeneration++
    this.searching = false
    this.navigation.clear()
    this.draft.clear()
    this.provIdx = Math.max(0, this.providers().indexOf(p))
    if (this.scene !== 'search') this.scene = 'workspace'
    void this.discovery.open(p, this.discovery.view.mode)
  }

  private toggleMode(): void {
    const v = this.discovery.view
    void this.discovery.open(v.provider, v.mode === 'home' ? 'rank' : 'home')
  }

  /** Left/right move the column. One column means the other mode is the only move. */
  private stepSection(dir: -1 | 1): void {
    const sections = this.discovery.visibleSections
    if (sections.length <= 1) {
      this.toggleMode()
      return
    }
    const next = this.discovery.view.sectionIndex + dir
    const index = next < 0 ? sections.length - 1 : next >= sections.length ? 0 : next
    void this.discovery.choose(index)
  }

  private updateWorkspace(k: string, _shift?: boolean) {
    if (!this.providers().includes(this.discovery.view.provider)) {
      this.say('当前 Key 无此平台权限', 'warn')
      return
    }
    if (['1', '2', '3', '4', '5', '6', '7'].includes(k)) {
      this.switchPlatform(Number(k) - 1)
      return
    }
    const v = this.discovery.view
    v.focus = 'list'
    if (k === 'tab') {
      this.toggleMode()
      return
    }
    if (k === 'left' || k === '[' || k === 'right' || k === ']') {
      this.stepSection(k === 'left' || k === '[' ? -1 : 1)
      return
    }
    if (k === '/' || k === 's') {
      this.pushNavigation('workspace', v.cursor)
      this.scene = 'search'
      return
    }
    if (k === 'r') {
      void this.discovery.open(v.provider, v.mode, true)
      return
    }
    if (k === 'f') {
      if (!this.discovery.section?.filters?.length) {
        this.say('这个栏目没有筛选', 'warn')
        return
      }
      const options = this.discovery.section.filters.flatMap((f) =>
        f.options.map((o) => ({ key: f.key, value: o.value })),
      )
      const active = options.findIndex((o) => v.filters[o.key] === o.value)
      this.filterIndex = Math.max(0, active)
      this.scene = 'filters'
      return
    }
    if (k === 'enter') {
      if (v.cursor === v.rows.length && v.more) {
        void this.discovery.load(true)
        return
      }
      const row = v.rows[v.cursor]
      if (row) void this.openRow(row)
      return
    }
    v.cursor = moveCursor(
      v.cursor,
      k === 'j' ? 'down' : k === 'k' ? 'up' : k,
      v.rows.length + (v.more ? 1 : 0),
      this.viewport.height - 8,
    )
  }
  private updateFilters(k: string) {
    const filters = this.discovery.section?.filters ?? []
    const options = filters.flatMap((f) =>
      f.options.map((o) => ({ ...o, key: f.key })),
    )
    if (k === 'esc') {
      this.scene = 'workspace'
      return
    }
    if (k === 'enter') {
      const item = options[this.filterIndex]
      if (item) {
        this.scene = 'workspace'
        void this.discovery.filter(item.key, item.value)
      }
      return
    }
    this.filterIndex = moveCursor(
      this.filterIndex,
      k,
      options.length,
      this.viewport.height - 8,
    )
  }
  private async openRow(row: Row) {
    const origin = this.scene
    const generation = this.requestGeneration
    const target = row.target
    if(target?.type==='video'&&row.sub==='youku'){await this.downloadYoukuLink(target.id||row.id, row);return}
    if (target?.type === 'unavailable') {
      this.say(target.reason || '此条目不可下载', 'warn')
      return
    }
    if (target?.type === 'channel') {
      if (target.sectionId)
        await this.discovery.channel(target.sectionId, row.title)
      return
    }
    if (
      target?.type === 'search' ||
      (!row.id && !target?.id) ||
      row.id.includes('://')
    ) {
      if (this.searching) return
      await this.search(row.sub, target?.query || row.title)
      return
    }
    if (row.sub === 'douyin') {
      await this.downloadDouyin(
        row.title,
        row.id,
        `https://www.douyin.com/video/${row.id}`,
      )
      return
    }
    if (this.busy) return
    this.pushNavigation(
      this.scene,
      this.scene === 'workspace' ? this.discovery.view.cursor : this.cursor,
    )
    this.detailProv = row.sub
    this.detailId = target?.id || row.id
    await this.detail(row.sub, this.detailId, '', row.mediaKind)
    if (this.scene === origin && this.requestGeneration === generation + 1)
      this.navigation.pop()
  }

  private updateSearch(k: string, shift?: boolean): void {
    if (k === 'esc') {
      this.back()
      return
    }
    if (k === 'left' || k === 'right' || k === 'tab') {
      const list = this.providers()
      if (!list.length) return
      const n = list.length
      const back = k === 'left' || (k === 'tab' && shift)
      this.provIdx = back ? (this.provIdx - 1 + n) % n : (this.provIdx + 1) % n
      this.requestGeneration++
      this.searching = false
      return
    }
    if (k !== 'enter' || this.searching) return
    const query = this.query.trim(),
      p = this.providers()[this.provIdx]
    if (!query || !p) {
      this.say('请选择有权限的平台并输入关键词', 'warn')
      return
    }
    const manifest = providerLink(query)
    if (manifest) { if (!this.has(manifest.provider)) { this.say('当前 Key 没有该平台权限', 'warn'); return }; void this.detail(manifest.provider, manifest.url); return }
    if (!supportsSearch(p)) { void this.detail(p, query); return }
    const yk = extractYoukuVideoId(query),
      dy = extractDouyinURL(query),
      txLinks = extractTencentLinks(query)
    if (yk) {
      void this.downloadYoukuLink(yk)
      return
    }
    if (dy) {
      void this.downloadDouyin('', '', dy)
      return
    }
    if (txLinks.length && this.has('tencent')) {
      void this.openTencentLinks(txLinks)
      return
    }
    void this.search(p, query)
  }

  private updateResults(k: string): void {
    if (k === 'esc') {
      this.back()
      return
    }
    if (k === '/') {
      this.scene = 'search'
      return
    }
    if (k === 'enter') {
      if (this.cursor === this.rows.length && this.listMore) {
        void this.loadMore()
        return
      }
      const row = this.rows[this.cursor]
      if (row) void this.openRow(row)
    } else
      this.cursor = moveCursor(
        this.cursor,
        k,
        this.rows.length + (this.listMore ? 1 : 0),
        this.viewport.height - 6,
      )
  }

  private updateDetail(k: string, shift = false): void {
    const groups = episodeCollections(this.episodeCatalog)
    if ((k === '[' || k === ']') && groups.length > 1) {
      const i = groups.indexOf(this.episodeGroup)
      this.episodeGroup = groups[(i + (k === ']' ? 1 : groups.length - 1)) % groups.length]!
      for (const ep of this.episodeCatalog) ep.selected = false
      this.eps = this.episodeCatalog.filter(e => e.collection === this.episodeGroup)
      this.cursor = this.selectAnchor = 0
      this.say(`${this.episodeGroup} · ${this.eps.length} 条 · 仅选择当前栏目`)
      this.emit()
      return
    }
    if (k.toLowerCase() === 'i' || (k === 'esc' && this.detailExpanded)) {
      this.detailExpanded = !this.detailExpanded
      this.contentOffset = 0
      return
    }
    if (this.detailExpanded) {
      const lines = wrapLines(this.detailInfo?.desc || '暂无简介', this.viewport.width - 2)
      const room = viewMetrics(this.viewport.width, this.viewport.height).scrollRoom
      this.contentOffset = moveCursor(this.contentOffset, k, Math.max(1, lines.length - room + 1), room)
      return
    }
    const n = this.eps.length
    if (!n) {
      if (k === 'esc') this.back()
      return
    }
    if (this.selectAnchor < 0 || this.selectAnchor >= n) this.selectAnchor = this.cursor
    if (k === 'esc') {
      this.back()
      return
    }
    if (k.toLowerCase() === 'm' && (this.detailProv === 'youku' || this.detailProv === 'tencent')) {
      this.setTitleKind(this.isMovie() ? 'show' : 'movie')
      this.say(`类型已设为${this.isMovie() ? '电影' : '剧集'} · M 切换，确认页可检查命名`, 'ok')
      return
    }
    if (this.detailProv === 'douyin' && (k === 'enter' || k === 'd')) {
      this.scene = 'quality'
      return
    }
    const move = (next: number) => {
      const clamped = Math.max(0, Math.min(n - 1, next))
      if (shift) {
        const a = Math.min(this.selectAnchor, clamped)
        const b = Math.max(this.selectAnchor, clamped)
        for (let i = a; i <= b; i++) this.eps[i]!.selected = true
        this.say(`已连选 ${b - a + 1} ${this.pickNoun()}`, 'ok')
      } else this.selectAnchor = clamped
      this.cursor = clamped
    }
    if (k === 'left' || k === 'h') move(this.cursor - 1)
    else if (k === 'right' || k === 'l') move(this.cursor + 1)
    else if (
      ['down', 'up', 'pageup', 'pagedown', 'home', 'end', 'j', 'k'].includes(k)
    ) {
      const gridWidth = Math.max(1, this.viewport.width - 2)
      const perRow = this.isMovie()
        ? 1
        : gridWindow(n, this.cursor, gridWidth, 1).perRow
      move(
        moveCursor(
          this.cursor,
          k === 'j' ? 'down' : k === 'k' ? 'up' : k,
          n,
          viewMetrics(this.viewport.width, this.viewport.height).gridRows * perRow,
          perRow,
        ),
      )
    }
    else if (k === ' ' || k === 'space') {
      this.eps[this.cursor]!.selected = !this.eps[this.cursor]!.selected
      this.selectAnchor = this.cursor
    } else if (k === 'a') {
      for (const ep of this.eps) ep.selected = true
      this.say(`已选 ${n} ${this.pickNoun()}`, 'ok')
    } else if (k === 'c') {
      for (const ep of this.eps) ep.selected = false
      this.say('已清空选择')
    } else if (k === 'enter' || k === 'd') {
      const tasks = this.selectedTasks()
      void this.queueEpisodes(
        tasks.length ? tasks : [this.taskFromEp(this.cursor)],
      )
    } else if (k === 'A' || k === 'f') {
      void this.queueEpisodes(this.eps.map((_, i) => this.taskFromEp(i)))
    }
  }

  private updateQuality(k: string): void {
    const nq = this.qualities.length
    const na = this.audios.length
    const hasAudio = na > 0
    if (k === 'esc') {
      this.requestGeneration++
      this.searching = false
      this.scene = 'detail'
      this.cursor = this.detailCursor
      this.selectAnchor = this.detailCursor
      return
    }
    if (this.searching) return
    if (
      hasAudio &&
      (k === 'tab' || k === 'left' || k === 'right' || k === 'h' || k === 'l')
    ) {
      this.optionTab = this.optionTab === 'quality' ? 'audio' : 'quality'
      return
    }
    const onAudio = hasAudio && this.optionTab === 'audio'
    const n = onAudio ? na : nq
    if (!n) {
      if (k === 'enter' || k === 'r') void this.queueEpisodes(this.pending)
      return
    }
    if (onAudio && (k === ' ' || k === 'space')) {
      const row = this.audios[this.audioIdx]
      if (row && !row.embedded) row.selected = !row.selected
      return
    }
    if (onAudio && k === 'a') {
      for (const row of this.audios) row.selected = true
      return
    }
    if (onAudio && k === 'c') {
      for (const row of this.audios) if (!row.embedded) row.selected = false
      return
    }
    if (['pageup', 'pagedown', 'home', 'end'].includes(k)) {
      if (onAudio)
        this.audioIdx = moveCursor(
          this.audioIdx,
          k,
          n,
          viewMetrics(this.viewport.width, this.viewport.height).qualityRows,
        )
      else this.qIdx = moveCursor(this.qIdx, k, n, viewMetrics(this.viewport.width, this.viewport.height).qualityRows)
      this.syncEmbeddedAudio()
      return
    }
    if (k === 'j' || k === 'down') {
      if (onAudio) this.audioIdx = Math.min(n - 1, this.audioIdx + 1)
      else this.qIdx = Math.min(n - 1, this.qIdx + 1)
    } else if (k === 'k' || k === 'up') {
      if (onAudio) this.audioIdx = Math.max(0, this.audioIdx - 1)
      else this.qIdx = Math.max(0, this.qIdx - 1)
    } else if (k === 'enter') {
      this.applyOptions()
      void this.afterQuality()
    }
    this.syncEmbeddedAudio()
  }

  private syncEmbeddedAudio(): void {
    const audios = this.qualities[this.qIdx]?.audios
    if (audios) { this.audios = audios.map(a => ({...a})); this.audioIdx = 0 }
  }

  /** Stamp the chosen quality (and audio track) onto every pending task. */
  private applyOptions(): void {
    const q = this.qualities[this.qIdx]
    const picked = this.audios.filter((a) => a.selected)
    const tracks = selectAudioTracks(this.audios, picked.map(a => a.id)).map((a) => ({
      id: a.id,
      label: a.label,
      lang: a.lang,
      vid: a.vid,
      codec: a.codec,
      isDefault: a.isDefault,
    }))
    const a = this.audios[this.audioIdx]
    for (const t of this.pending) {
      if (q) {
        t.quality = q.stream || q.id
        t.caption = q.caption
        if (t.provider === 'tencent') t.tencentQuality = selectedTencentQuality(q)
        t.group = this.cfg.releaseGroup
        if (q.height > 0) t.height = q.tier || ((t.provider === 'hongguo' || t.provider === 'huangguo') && q.width > 0 && q.height > q.width
          ? tierHeight(q.height, q.width) : tierHeight(q.width, q.height))
        if (q.codec) t.codec = q.codec
      }
      // Clone per task. Youku: rebind probe-episode audio vids onto this episode
      // (or its language sibling) so batch downloads never cross-wire A/V.
      t.audioTracks = t.provider === 'youku'
        ? bindYoukuAudioTracksToTask(tracks, t)
        : tracks.map((a) => ({ ...a }))
    }
    this.probeFailed = false
    if (q) {
      const name = qualityChoiceLabel(q)
      this.say(a ? `画质 ${name} · 音轨 ${a.label}` : `画质 ${name}`, 'ok')
    }
  }

  private updateTMDB(k: string): void {
    k = k.toLowerCase()
    if (k === 'r') {
      void this.matchTMDB()
      return
    }
    if (k === 'esc') {
      this.requestGeneration++
      this.searching = false
      this.scene = 'quality'
      return
    }
    if (k === 's') {
      this.requestGeneration++
      this.searching = false
      this.scene = 'confirm'
      this.say('已跳过 TMDB 匹配，请检查命名示例')
      return
    }
    if (this.searching) return
    if (this.tmdbHits.length && (k === 'j' || k === 'down'))
      this.cursor = (this.cursor + 1) % this.tmdbHits.length
    else if (this.tmdbHits.length && (k === 'k' || k === 'up'))
      this.cursor =
        (this.cursor - 1 + this.tmdbHits.length) % this.tmdbHits.length
    else if (k === 'enter' && this.tmdbHits[this.cursor]) {
      const h = this.tmdbHits[this.cursor]
      this.setTitleKind(h.kind)
      for (const t of this.pending) {
        t.tmdbId = h.id
        t.year = h.year
        t.nameDots = dots(h.name)
        t.plot = h.overview ?? ''
        if (h.name) t.series = h.name
      }
      this.scene = 'confirm'
      this.say(`已匹配${h.kind === 'movie' ? '电影' : '剧集'}：${h.name || h.title}`, 'ok')
    }
  }

  private persistConfig() {
    if (!this.simulated) saveConfig(this.cfg)
  }

  private updateSettings(k: string): void {
    const fields = this.settingFields()
    if (k.toLowerCase() === 'i' || (k === 'esc' && this.settingsExpanded)) {
      this.settingsExpanded = !this.settingsExpanded
      this.contentOffset = 0
      return
    }
    if (this.settingsExpanded) {
      const label = fields[this.setIdx] || ''
      const lines = settingInfoLines(label, this.settingValue(label)).flatMap(line => wrapLines(line, this.viewport.width - 2))
      const room = viewMetrics(this.viewport.width, this.viewport.height).scrollRoom
      this.contentOffset = moveCursor(this.contentOffset, k, Math.max(1, lines.length - room + 1), room)
      return
    }
    if (k === 'esc') {
      this.back()
      if (!this.simulated) this.persistConfig()
      return
    }
    const group = settingGroup(fields[this.setIdx] || '')
    const groups = [...new Set(fields.map(settingGroup))]
    const indices = fields.flatMap((field, index) => settingGroup(field) === group ? [index] : [])
    if (['left', 'right', 'tab'].includes(k) && groups.length) {
      const next = groups[(groups.indexOf(group) + (k === 'left' ? groups.length - 1 : 1)) % groups.length]
      this.setIdx = fields.findIndex(field => settingGroup(field) === next)
    } else if (indices.length && ['j', 'down', 'k', 'up', 'home', 'end', 'pageup', 'pagedown'].includes(k)) {
      const key = k === 'j' ? 'down' : k === 'k' ? 'up' : k
      const index = moveCursor(indices.indexOf(this.setIdx), key, indices.length, viewMetrics(this.viewport.width, this.viewport.height).settingRows)
      this.setIdx = indices[index]!
    }
    else if (k === 'enter' || k === ' ' || k === 'space') {
      if (fields[this.setIdx]) void this.openSetting(fields[this.setIdx])
    }
  }

  private updateEdit(k: string): void {
    if (k === 'esc') {
      this.providerLoginGeneration++
      this.editValue = ''
      this.scene = this.editField === '确认下载目录' ? 'confirm' : 'settings'
      return
    }
    if (k === 'enter') void this.commitEdit(this.editValue.trim())
  }

  private async openSetting(f: string): Promise<void> {
    if (f === '腾讯诊断日志') { this.say(tencentDiagnosticPath() + ' · 任务详情可看该任务诊断'); this.emit(); return }
    if (f === '腾讯观测绑定') { this.cfg.tencentObservations = !this.cfg.tencentObservations; this.persistConfig(); this.emit(); return }
    if (f === 'Hami 会话类型') { this.cfg.hamiClient = this.cfg.hamiClient === 'web' ? 'tv' : 'web'; this.persistConfig(); this.emit(); return }
    const loginCommands: Record<string, SessionCommand> = {
      'mewatch profiles': {provider:'mewatch',op:'profiles'}, 'Hami TV 续期': {provider:'hamivideo',op:'refresh'},
      'mewatch 激活': {provider:'mewatch',op:'start'}, 'mewatch 检查授权': {provider:'mewatch',op:'poll'}, 'mewatch 状态': {provider:'mewatch',op:'status'}, 'mewatch 退出': {provider:'mewatch',op:'logout'},
      'Hami Web 准备': {provider:'hamivideo',op:'web_start'}, 'Hami 状态': {provider:'hamivideo',op:this.cfg.hamiClient === 'web' ? 'web_status' : 'status'}, 'Hami 退出': {provider:'hamivideo',op:this.cfg.hamiClient === 'web' ? 'web_logout' : 'logout'},
    }
    if (loginCommands[f]) { await this.providerLogin(loginCommands[f]!); return }
    if (
      this.simulated &&
      [
        '网关',
        'Key',
        '优酷登录',
        '优酷扫码',
        '腾讯 Cookie', '腾讯双扫码', '腾讯登录',
        '抖音 Cookie',
      ].includes(f)
    ) {
      this.say('离线演示不连接账号服务；可测试目录、命名和封装设置')
      this.emit()
      return
    }
    if (f === '运行日志') {
      this.say(`运行日志：${runLogPath()}（GVS_TUI_LOG=0 可关闭）`, 'info')
      this.emit()
      return
    }
    if (f === '隧道') {
      this.say(
        this.tunnelOk ? '隧道已连接' : this.tunnelErr || '未连接',
        this.tunnelOk ? 'ok' : 'warn',
      )
      this.emit()
      return
    }
    if (f === '优酷登录') {
      if (!this.cfg.youkuSign) {
        void this.openSetting('优酷扫码')
        return
      }
      if (this.signMissing) {
        this.say(
          '本机签名在网关凭证库里已经没有了，续期不可能成功 → 直接扫码',
          'warn',
        )
        this.emit()
        void this.openSetting('优酷扫码')
        return
      }
      this.say('正在续期并查询会员状态…')
      this.emit()
      const ok = await this.renewYoukuLogin()
      await this.checkYoukuAccount()
      if (!ok || this.ykAcct?.needsScan) {
        this.say(
          '登录态不可用，续期救不回来 → 设置 → 优酷扫码 重新登录',
          'warn',
        )
      } else {
        const probe = this.vipProbe
        const tail = probe
          ? ` · 取流: ${probe.canPlay ? '可播' : '不可播'}${probe.isVip ? ' · 会员权益✓' : ''}${probe.hasTrial ? ' · 仅试看' : ''}`
          : ''
        this.say(
          `${accountSummary(this.ykAcct)}${tail}`,
          probe && probe.canPlay ? 'ok' : 'info',
        )
      }
      this.emit()
      return
    }
    if (f === '腾讯双扫码' && this.cli) {
      this.stopQR()
      this.qrTencent = null
      this.qrTencentDual = true
      this.qrDualDone = { app: false, tv: false }
      this.qrHint = '同时扫两张码：腾讯视频 App（左/先打开）+ 云视听极光 TV；会话各自独立保存'
      try {
        const paths = await this.work(() => startTencentDualQR(this.cli!, this.cfg))
        this.qrPngPaths = [paths.appPath, paths.tvPath]
        this.qrAscii = ''
        this.scene = 'qr'
        this.say('App 与 TV 二维码已保存本机并尝试打开；先扫任意一张均可', 'info')
        this.startQRPoll()
      } catch (e) {
        this.qrTencentDual = false
        this.say(e instanceof Error ? e.message : String(e), 'err')
      }
      this.emit()
      return
    }
    if (f === '腾讯登录') {
      await this.refreshTencentAccount(true)
      return
    }
    if (f === '优酷扫码') {
      this.qrTencent = null
      this.qrTencentDual = false
      this.qrHint = '用优酷 App 扫码登录，登录态会写进本机'

      if (!this.cli) return
      this.say(
        hostIsLocal(this.cfg.host)
          ? '本机网关，扫码从家庭 IP 出去。'
          : '扫码从本机 IP 出网（隧道）。',
      )
      try {
        const qr = await startYoukuQR(this.cli)
        this.qrTicket = qr.ticket
        this.qrLoginToken = qr.loginToken
        this.qrPolls = 0
        this.qrAscii = qr.ascii
        this.qrPngPaths = qr.pngPaths
        this.scene = 'qr'
        const qrPath = qr.pngPaths[0]
        this.say(
          qr.imageOpened
            ? `二维码图片已打开 · ${qrPath}`
            : qrPath
              ? `二维码图片已生成 · ${qrPath}`
              : '等待扫码确认',
          qr.imageOpened ? 'ok' : 'info',
        )
        this.startQRPoll()
      } catch (e) {
        this.say(e instanceof Error ? e.message : String(e), 'err')
        this.scene = 'settings'
      }
      this.emit()
      return
    }
    if (f === 'Yk-Sign') {
      this.say('登录态由扫码写入，不能手改。', 'warn')
      this.emit()
      return
    }
    if (f === '腾讯 caption=all') {
      this.cfg.tencentCaptionAll = !this.cfg.tencentCaptionAll
      this.persistConfig()
      this.say(
        this.cfg.tencentCaptionAll
          ? '已开启 caption=all 探测（软+硬，请求更重）'
          : '已关闭 caption=all（默认只探 soft）',
        'ok',
      )
      this.emit()
      return
    }
    if (f === '腾讯探测原画') {
      this.cfg.tencentProbeSource = !this.cfg.tencentProbeSource
      this.persistConfig()
      this.say(
        this.cfg.tencentProbeSource
          ? '已开启画质列表 source=1 / 原画探测（易触发权益锁）'
          : '已关闭画质列表原画探测（默认；选原画档仍会带 source=1）',
        'ok',
      )
      this.emit()
      return
    }
    if (f === '腾讯 encode=all') {
      this.cfg.tencentEncodeAll = !this.cfg.tencentEncodeAll
      this.persistConfig()
      this.say(
        this.cfg.tencentEncodeAll
          ? '已开启 encode=all 探测（风控敏感，仅画质列表）'
          : '已关闭 encode=all（默认）',
        'ok',
      )
      this.emit()
      return
    }
    if (f === '红果合并') {
      this.cfg.hongguoMerge = !this.cfg.hongguoMerge
      this.persistConfig()
      this.emit()
      return
    }
    if (f === '红果 NFO') {
      this.cfg.hongguoNfo = !this.cfg.hongguoNfo
      this.persistConfig()
      this.emit()
      return
    }
    if (f === '红果封装') {
      this.cfg.hongguoFmt = this.cfg.hongguoFmt === 'mp4' ? 'mkv' : 'mp4'
      this.persistConfig()
      this.emit()
      return
    }
    if (f === '黄果 NFO') {
      this.cfg.huangguoNfo = !this.cfg.huangguoNfo
      this.persistConfig()
      this.emit()
      return
    }
    if (f === '黄果封装') {
      this.cfg.huangguoFmt = this.cfg.huangguoFmt === 'mp4' ? 'mkv' : 'mp4'
      this.persistConfig()
      this.emit()
      return
    }
    this.editField = f
    this.editValue = this.editSeed(f)
    this.scene = 'edit'
    if (f === 'TMDB 代理') this.say('填写 HTTP/HTTPS 代理地址；仅用于 TMDB，留空使用默认网络')
    if (f === '网关代理') this.say('填写 HTTP/HTTPS 代理地址，保存后用于网关请求和隧道；留空直连')
    this.emit()
  }

  private async providerLogin(command: SessionCommand): Promise<void> {
    if (this.simulated || !this.cli || !this.has(command.provider) || this.providerLoginBusy) { this.say('请先连接有权限的真实网关，或等待当前请求完成', 'warn'); this.emit(); return }
    this.providerLoginBusy = true
    const generation = this.providerLoginGeneration
    const scope = this.cfg.host + ':' + this.cfg.key
    this.providerSessions.setScope(scope)
    try {
      const view = await this.providerSessions.command(command)
      if (scope !== this.cfg.host + ':' + this.cfg.key || generation !== this.providerLoginGeneration) return
      if (command.op === 'web_verify' && view.authenticated) { this.cfg.hamiClient = 'web'; this.persistConfig() }
      if (command.op === 'import' && view.state === 'imported') { this.cfg.hamiClient = 'tv'; this.persistConfig() }
      if (command.provider === 'mewatch' && view.state === 'pending' && view.url) {
        if (command.op === 'start') { this.cancelQRScene(); this.mewatchQR = true; this.scene = 'qr'; this.qrAscii = await QRCode.toString(view.url, { type: 'terminal', small: true }) }
        if (this.mewatchQR) this.qrHint = `mewatch 官方激活页 · 代码 ${view.userCode || ''} · 回车检查（至少 ${view.interval || 5}s）`
      } else if (command.provider === 'mewatch' && this.mewatchQR) { this.cancelQRScene(); this.scene = 'settings' }
      this.say(view.summary + (view.profiles?.length ? ' · ' + view.profiles.map(p => p.id + ':' + p.name).join(' / ') : '') + (view.url && this.scene !== 'qr' ? ' · ' + view.url : ''), view.authenticated ? 'ok' : 'info')
    } catch (e) { this.say(e instanceof Error ? e.message : '账号操作失败', 'err') }
    finally { this.providerLoginBusy = false; this.emit() }
  }

  private async commitEdit(v: string): Promise<void> {
    const commands: Record<string, SessionCommand> = {
      'Hami TV Cookie': {provider:'hamivideo',op:'import',cookie:v},
      'Hami 手机号（确认发码）': {provider:'hamivideo',op:'web_send_code',phone:v,confirm:true},
      'Hami 短信码': {provider:'hamivideo',op:'web_verify',code:v},
      'mewatch profile': {provider:'mewatch',op:'profile',profileId:v.split(' ')[0],pin:v.split(' ')[1]},
    }
    if (commands[this.editField]) { this.editValue = ''; this.scene = 'settings'; this.emit(); await this.providerLogin(commands[this.editField]!); return }
    if (this.editField === '确认下载目录') {
      const next = normalizeOutDir(v)
      if (!next) {
        this.say('下载目录不能为空', 'warn')
        return
      }
      this.cfg.outDir = next
      this.persistConfig()
      this.say('下载目录已保存', 'ok')
      this.scene = 'confirm'
      this.emit()
      return
    }
    switch (this.editField) {
      case '网关代理':
        try { this.cfg.gatewayProxy = normalizeHttpProxy(v) }
        catch (e) {
          this.say(e instanceof Error ? e.message : '代理地址格式无效', 'warn')
          this.emit()
          return
        }
        this.restartTunnel()
        break
      case '网关':
        this.discovery.clear()
        this.keyInfo = null
        this.cfg.host = v.replace(/\/+$/, '')
        if (this.cfg.key) this.cli = new GwClient(this.cfg.host, this.cfg.key, () => this.cfg)
        this.persistConfig()
        this.scene = 'settings'
        await this.refreshKey()
        return
      case 'Key':
        this.discovery.clear()
        this.keyInfo = null
        this.cfg.key = v
        this.cli = new GwClient(this.cfg.host, this.cfg.key, () => this.cfg)
        this.persistConfig()
        this.scene = 'settings'
        await this.refreshKey()
        return
      case '下载目录': {
        const next = normalizeOutDir(v)
        if (!next) {
          this.say('下载目录不能为空', 'warn')
          this.scene = 'settings'
          this.emit()
          return
        }
        this.cfg.outDir = next
        break
      }
      case '下载线程':
        this.cfg.threads = clampThreads(v)
        break
      case '发布组':
        this.cfg.releaseGroup = v
        break
      case 'TMDB Key':
        this.cfg.tmdbKey = v
        break
      case 'TMDB 代理':
        try { this.cfg.tmdbProxy = normalizeTmdbProxy(v) }
        catch (e) {
          this.say(e instanceof Error ? e.message : '代理地址格式无效', 'warn')
          this.emit()
          return
        }
        break
      case '腾讯 TV 设备 ID': this.cfg.tencentTVDevice = v; break
      case '腾讯 TV QUA': this.cfg.tencentTVQUA = v; break
      case '腾讯 TV 版本': this.cfg.tencentTVVersion = v; break
      case '腾讯 Cookie':
        this.cfg.tencentCookie = v
        this.cfg.tencentMode = 'cookie'
        break
      case '抖音 Cookie':
        this.cfg.douyinCookie = v.trim()
        break
    }
    this.persistConfig()
    this.say(`${this.editField} 已保存`, 'ok')
    this.scene = 'settings'
    this.emit()
    if (this.editField === '腾讯 Cookie') void this.refreshTencentAccount(false)
  }

  private isMovie(): boolean {
    return this.detailInfo?.kind === 'movie'
  }

  private setTitleKind(kind: TitleKind): void {
    if (this.detailInfo) this.detailInfo.kind = kind
    for (const task of this.pending) {
      task.kind = kind
      if (kind === 'movie') {
        task.season = 0
        task.episode = 0
        task.edition = movieEdition(task.title, this.detailTitle)
      } else {
        task.season = seriesSeason(this.eps.find(ep => ep.vid === task.vid)?.season || task.season, this.detailTitle)
        task.episode = this.eps.find(ep => ep.vid === task.vid)?.number || task.episode || 1
        task.edition = ''
      }
    }
  }

  private pickNoun(): string {
    return this.isMovie() ? '个版本' : '集'
  }

  private taskFromEp(i: number): DlTask {
    const ep = this.eps[i]
    const movie = this.isMovie()
    return {
      provider: this.detailProv,
      title: ep.title,
      series: movie ? this.detailTitle : parseSeriesTitle(this.detailTitle).title,
      vid: ep.vid,
      season: movie ? 0 : seriesSeason(ep.season, this.detailTitle),
      episode: movie ? 0 : ep.number || i + 1,
      collection: ep.collection,
      height: 0,
      quality: '',
      group: this.cfg.releaseGroup,
      codec: '',
      tmdbId: 0,
      nameDots: '',
      year: this.detailInfo?.year ?? 0,
      plot: '',
      kind: movie ? 'movie' : 'show',
      edition: movie ? movieEdition(ep.title, this.detailTitle) : '',
      languages: ep.languages
        ?.filter((l) => l.vid)
        .map((l) => ({ vid: l.vid, lang: l.lang })),
    }
  }

  private selectedTasks(): DlTask[] {
    return this.eps.flatMap((ep, i) =>
      ep.selected ? [this.taskFromEp(i)] : [],
    )
  }

  private probeLangOpts(skipSign = false): { skipSign?: boolean; languages?: Array<{ vid: string; lang: string }> } {
    const seen: Record<string, true> = {}
    const languages: Array<{ vid: string; lang: string }> = []
    for (const t of this.pending) {
      for (const l of t.languages ?? []) {
        if (!l.vid || seen[l.vid]) continue
        seen[l.vid] = true
        languages.push({ vid: l.vid, lang: l.lang })
      }
    }
    return { skipSign: skipSign || undefined, languages: languages.length ? languages : undefined }
  }


  private async queueEpisodes(tasks: DlTask[]): Promise<void> {
    if (!tasks.length || !this.cli) return
    if (this.busy) return
    const generation = this.requestGeneration
    this.detailCursor = this.cursor
    this.pending = tasks
    this.scene = 'quality'
    this.probeFailed = false
    this.qualities = []
    this.audios = []
    this.qIdx = 0
    this.audioIdx = 0
    if (this.simulated) {
      const demo = demoSnapshot('quality', 0)
      this.adoptOptions(
        { qualities: demo.qualities ?? [], audios: demo.audios ?? [] },
        tasks.length,
      )
      this.emit()
      return
    }
    this.say('正在取画质…')
    this.emit()
    try {
      const opts = await this.work(() =>
        probeOptions(this.cli!, this.cfg, this.detailProv, tasks[0].vid, this.probeLangOpts()),
      )
      if (generation !== this.requestGeneration) return
      this.adoptOptions(opts, tasks.length)
    } catch (e) {
      if (generation !== this.requestGeneration) return
      if (e instanceof ReloginRequired && this.cfg.youkuSign) {
        // ① 先续期：网关能用 stoken/ptoken 自己续，续成功就重试原请求，
        //    用户完全不用重新扫码（"重启就失效"多半就是缺了这一步）。
        this.say('优酷登录态失效，尝试自动续期…', 'warn')
        this.emit()
        if (await this.renewYoukuLogin()) {
          try {
            const opts = await this.work(() =>
              probeOptions(this.cli!, this.cfg, this.detailProv, tasks[0].vid, this.probeLangOpts()),
            )
            if (generation !== this.requestGeneration) return
            this.adoptOptions(opts, tasks.length)
            this.emit()
            return
          } catch (afterRenew) {
            if (generation !== this.requestGeneration) return
            this.failProbe(
              afterRenew instanceof Error
                ? afterRenew.message
                : String(afterRenew),
              true,
            )
            this.emit()
            return
          }
        }
        // ② 续期也不行 → 试一次不带签名的请求（网关自己的优酷会话兜底）。
        //    只覆盖这一次请求的请求头，**不动配置文件**：早先那版把用户的
        //    签名从 tui.json 里删掉了，属于我越权，这里不再重犯。
        if (generation !== this.requestGeneration) return
        this.say('续期未成功，这次先用网关侧的优酷会话试试…', 'warn')
        this.emit()
        try {
          const opts = await this.work(() =>
            probeOptions(this.cli!, this.cfg, this.detailProv, tasks[0].vid, this.probeLangOpts(true)),
          )
          if (generation !== this.requestGeneration) return
          this.adoptOptions(opts, tasks.length)
          this.say(
            '本次用网关会话取流成功；本机签名仍不可用，建议 设置 → 优酷扫码',
            'warn',
          )
          this.emit()
          return
        } catch (again) {
          if (generation !== this.requestGeneration) return
          this.failProbe(
            again instanceof Error ? again.message : String(again),
            true,
          )
          this.emit()
          return
        }
      }
      this.failProbe(
        e instanceof Error ? e.message : String(e),
        e instanceof ReloginRequired,
      )
    }
    this.emit()
  }

  private adoptOptions(
    opts: { qualities: Quality[]; audios: Audio[]; vip?: VipProbe },
    count: number,
  ): void {
    if (!opts.qualities.length || opts.vip?.canPlay === false) {
      this.failProbe('没有可用画质或当前账号不可播放', false)
      return
    }
    this.qualities = opts.qualities
    this.audios = opts.qualities[0]?.audios ?? opts.audios
    this.vipProbe = opts.vip ?? null
    this.qIdx = 0
    this.audioIdx = Math.max(
      0,
      opts.audios.findIndex((a) => a.isDefault),
    )
    this.optionTab = 'quality'
    this.probeFailed = false
    this.scene = 'quality'
    const rights = this.vipProbe
      ? ` · ${this.vipProbe.canPlay ? '可播' : '不可播'}${this.vipProbe.hasTrial ? '（仅试看）' : ''}`
      : ''
    this.say(
      `${opts.qualities.length} 档画质${opts.audios.length ? ` · ${opts.audios.length} 条音轨` : ''} · ${count} ${this.pickNoun()}${rights}`,
      this.vipProbe && !this.vipProbe.canPlay ? 'warn' : 'ok',
    )
  }

  private failProbe(message: string, relogin: boolean): void {
    this.probeFailed = true
    this.qualities = []
    this.audios = []
    this.vipProbe = null
    if (relogin) {
      this.say('优酷登录态失效，请检查设置；回车重试探测，Esc 返回', 'err')
      return
    }
    this.say(`取画质失败：${message} · 回车重试，Esc 返回`, 'err')
  }

  private async afterQuality(): Promise<void> {
    if (!this.pending.length || this.probeFailed) return
    if (this.searching) return
    this.searching = true
    const generation = this.requestGeneration
    if (!this.simulated && this.detailProv === 'tencent') {
      try {
        const targets = this.pending.slice(0, 2)
        if (targets.length >= 2) {
          const result = await this.work(() =>
            this.cli!.invoke(
              'tencent',
              'play',
              {
                vid: targets[0]!.vid,
                vid2: targets[1]!.vid,
                ...tencentPlayQualityInput(targets[0]!),
                ...tencentPlayInput(this.cfg),
              },
              this.cli!.extra(this.cfg, 'tencent'),
            ),
          )
          if (generation !== this.requestGeneration) return
          const probe = tencentPlayProbeOk(result)
          if (!probe.ok) {
            // Dual: also accept if either videos[] row probes ok.
            const rows = Array.isArray(result.videos) ? result.videos : []
            const anyRow = rows.some(
              (v) =>
                v &&
                typeof v === 'object' &&
                tencentPlayProbeOk(v as Record<string, unknown>).ok,
            )
            if (!anyRow) {
              runLog(`afterQuality dual fail ${probe.reason || 'no-url'}`)
              throw new Error(probe.reason || '双流探测：选定画质没有返回可用视频地址')
            }
            runLog('afterQuality dual ok via=videos')
          } else {
            runLog(`afterQuality dual ok via=${probe.via || 'ok'}`)
          }
        } else {
          const first = targets[0]!
          const result = await this.work(() =>
            this.cli!.invoke(
              'tencent',
              'play',
              { vid: first.vid, ...tencentPlayQualityInput(first), ...tencentPlayInput(this.cfg) },
              this.cli!.extra(this.cfg, 'tencent'),
            ),
          )
          if (generation !== this.requestGeneration) return
          const probe = tencentPlayProbeOk(result)
          if (!probe.ok) {
            runLog(`afterQuality fail ${probe.reason || 'no-url'}`)
            throw new Error(probe.reason || '选定画质没有返回可用视频地址')
          }
          runLog(`afterQuality ok via=${probe.via || 'ok'}`)
        }
      } catch (e) {
        if (generation !== this.requestGeneration) return
        this.searching = false
        const msg = e instanceof Error ? e.message : String(e)
        runLog(`afterQuality err ${msg}`)
        this.say(
          `选定画质探测失败：${msg} · Enter 重试 / Esc 返回`,
          'err',
        )
        this.emit()
        return
      }
    }
    if (
      !this.simulated &&
      (this.detailProv === 'youku' || this.detailProv === 'tencent') &&
      this.cfg.tmdbKey.trim()
    ) {
      this.searching = false
      await this.matchTMDB()
      return
    }
    if (generation !== this.requestGeneration) return
    this.searching = false
    this.scene = 'confirm'
    this.emit()
  }

  private async matchTMDB(): Promise<void> {
    if (this.searching || !this.pending.length) return
    const generation = this.requestGeneration
    this.searching = true
    this.tmdbHits = []
    this.tmdbState = 'loading'
    this.tmdbError = ''
    this.tmdbGeneration = generation
    this.cursor = 0
    this.scene = 'tmdb'
    this.say('正在搜索 TMDB 电影和剧集… · S 跳过 / Esc 返回')
    this.emit()
    try {
      const hits = await this.work(() => tmdbSearch(this.cfg.tmdbKey, this.cfg.tmdbLang, this.detailTitle, { proxy: this.cfg.tmdbProxy }))
      if (generation !== this.requestGeneration) return
      this.tmdbHits = hits
      this.tmdbState = 'ready'
      this.say(hits.length
        ? `${hits.length} 个候选 · 回车采用类型和片名，S 跳过`
        : 'TMDB 未找到匹配影片 · S 跳过 / R 重试 / Esc 返回', hits.length ? 'ok' : 'warn')
    } catch (e) {
      if (generation !== this.requestGeneration) return
      this.tmdbState = 'error'
      this.tmdbError = e instanceof Error ? e.message : 'TMDB 搜索失败'
      this.say(`${this.tmdbError} · S 跳过 / R 重试`, 'warn')
    } finally {
      if (generation === this.requestGeneration) {
        this.searching = false
        this.emit()
      }
    }
  }

  private enqueueAll(tasks: DlTask[]): void {
    if (!this.cli || !tasks.length) return
    const added = []
    for (const t of tasks) {
      const id = nextJobID()
      added.push({
        id,
        title: jobTitle(t),
        status: '排队',
        pct: 0,
        log: '',
        err: '',
      })
      if (!this.simulated) this.hub.enqueue({ ...this.cfg }, this.cli, id, t)
    }
    this.jobs.unshift(...added)
    this.pending = []
    this.pushNavigation('detail', this.detailCursor)
    this.cursor = 0
    this.scene = 'jobs'
    this.say(`已加入 ${tasks.length} 个任务`, 'ok')
    this.emit()
  }

  private async downloadDouyin(
    title: string,
    vid: string,
    url: string,
  ): Promise<void> {
    if (!this.cli || this.busy) return
    if (!this.has('douyin')) {
      this.say('当前 Key 没有抖音权限', 'err')
      this.emit()
      return
    }
    const generation = this.requestGeneration
    const link =
      url.trim() || (vid ? `https://www.douyin.com/video/${vid}` : '')
    if (!link) {
      this.say('没有抖音链接', 'err')
      this.emit()
      return
    }
    this.say('正在解析抖音链接…')
    this.emit()
    try {
      const data = await this.work(() =>
        this.cli!.invoke('douyin', 'resolve', { url: link }),
      )
      if (generation !== this.requestGeneration) return
      if (!pickDouyinURL(data))
        throw new Error('这条没有视频直链（可能是图文）')
      const desc = clipTitle(
        asString(data.content) || asString(data.title) || title,
      )
      let height = 0
      let width = 0
      const media = Array.isArray(data.media) ? data.media : []
      for (const it of media) {
        if (!isObj(it) || !asString(it.url)) continue
        const typ = asString(it.type)
        if (typ && typ !== 'video') continue
        height = anyInt(it.height)
        width = anyInt(it.width)
        break
      }
      const tier = tierHeight(width, height)
      this.pushNavigation(this.scene, this.cursor)
      this.detailProv = 'douyin'
      this.detailTitle = desc
      this.detailInfo = null
      this.episodeCatalog = []
    this.episodeGroup = ''
    this.eps = [
        {
          vid: vid || asString(data.id),
          title: desc,
          number: 1,
          selected: true,
        },
      ]
      this.qualities = [
        {
          title: '原始视频',
          id: tier > 0 ? `${tier}p` : 'source',
          label: tier > 0 ? `${tier}p` : '原始视频',
          width,
          height,
          codec: 'H264',
          size: 0,
          drm: '',
        },
      ]
      this.audios = []
      this.qIdx = 0
      this.cursor = 0
      this.detailCursor = 0
      this.pending = [
        {
          provider: 'douyin',
          title: desc,
          series: desc,
          vid: vid || asString(data.id),
          url: link,
          season: 0,
          episode: 0,
          height: tier,
          quality: tier > 0 ? `${tier}p` : '',
          group: '',
          codec: 'H264',
          tmdbId: 0,
          nameDots: '',
          year: 0,
          plot: '',
        },
      ]
      this.scene = 'detail'
      this.selectAnchor = this.cursor
      this.emit()
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), 'err')
      this.emit()
    }
  }
  /** 记住列表上下文，翻页时用同一个 provider/action 再打一次。 */
  private setListSpec(
    spec: { provider: string; action: string; input: Record<string, unknown> },
    data: Record<string, unknown>,
  ): void {
    this.listSpec = spec
    const info = pageInfo(data)
    this.listMore = info.more
    this.listCursor = info.cursor
  }

  /** 追加下一页；到底后 listMore=false，再按也不打请求。 */
  private async loadMore(): Promise<void> {
    if (!this.cli || !this.listSpec || !this.listMore || this.pageLoading)
      return
    this.pageLoading = true
    const generation = this.requestGeneration
    const spec = this.listSpec
    const cursor = this.listCursor
    if (!cursor) {
      this.listMore = false
      this.pageLoading = false
      this.say('已经是最后一页', 'info')
      this.emit()
      return
    }
    try {
      const data = await this.work(() =>
        this.cli!.invoke(spec.provider, spec.action, {
          ...spec.input,
          cursor,
          page: cursor,
        }),
      )
      if (generation !== this.requestGeneration) {
        this.pageLoading = false
        return
      }
      const more = discoveryRows(spec.provider, data)
      const seen = new Set(this.rows.map((r) => `${r.id}|${r.title}`))
      const fresh = more.filter((r) => !seen.has(`${r.id}|${r.title}`))
      this.rows = [...this.rows, ...fresh]
      this.setListSpec(spec, data)
      if (!fresh.length || this.listCursor === cursor) this.listMore = false
      this.cursor = Math.min(this.rows.length - 1, this.cursor)
      this.say(
        fresh.length
          ? `已加载 ${this.rows.length} 条${this.listMore ? ' · 还有更多' : ' · 到底了'}`
          : '没有更多了',
        fresh.length ? 'ok' : 'warn',
      )
    } catch (e) {
      if (generation !== this.requestGeneration) return
      this.say(e instanceof Error ? e.message : String(e), 'err')
    }
    this.pageLoading = false
    this.emit()
  }
  private async search(provider: string, q: string): Promise<void> {
    if (!this.cli || this.searching) return
    const generation = ++this.requestGeneration
    this.searching = true
    const origin = this.scene
    const originCursor = this.cursor
    try {
      const input = { q, pageSize: 20 }
      const data = await this.work(() =>
        this.cli!.invoke(provider, 'search', input),
      )
      if (generation !== this.requestGeneration) return
      this.pushNavigation(origin, originCursor)
      this.rows = discoveryRows(provider, data)
      this.setListSpec({ provider, action: 'search', input }, data)
      this.cursor = 0
      this.say(
        this.rows.length
          ? `${this.rows.length} 条 · ${provider}${this.listMore ? ' · 还有更多' : ''}`
          : '没有搜到结果',
        this.rows.length ? 'ok' : 'warn',
      )
      this.scene = 'results'
    } catch (e) {
      if (generation !== this.requestGeneration) return
      this.say(e instanceof Error ? e.message : String(e), 'err')
    }
    if (generation === this.requestGeneration) this.searching = false
    this.emit()
  }

  private async downloadYoukuLink(vid: string, row?: Row): Promise<void> {
    if (!this.cli || this.busy) return
    if (!this.has('youku')) {
      this.say('当前 Key 没有优酷权限', 'warn')
      this.emit()
      return
    }
    const generation = ++this.requestGeneration
    const origin=this.scene,originCursor=this.cursor
    this.say('正在解析优酷视频…')
    this.emit()
    let data: Record<string, unknown> = {}
    try {
      // The app detail endpoint needs a show ID; the web endpoint accepts a VID.
      data = await this.work(() =>
        this.cli!.invoke('youku', 'detail', { vid, proto: 'web' }),
      )
      if (isObj(data.show)) data = { ...data.show, ...data }
    } catch {
      // Metadata is optional: play can still resolve this exact video ID.
    }
    if (this.scene !== origin || generation !== this.requestGeneration) return
    this.detailProv = 'youku'
    this.detailId = vid
    this.detailTitle = asString(data.title) || row?.title || `优酷视频 ${vid}`
    this.detailInfo = parseDetail(data, 'youku', this.detailTitle, row?.mediaKind)
    const episode = parseEps(data).find((ep) => ep.vid === vid)
    this.episodeCatalog = []
    this.episodeGroup = ''
    this.eps = [
      episode ?? { vid, title: this.detailTitle, number: 1, selected: true },
    ]
    this.cursor = 0
    this.selectAnchor = 0
    this.probeFailed = false
    this.pushNavigation(origin, originCursor)
    this.scene = 'detail'
    this.eps[0].selected = true
    this.emit()
  }


  /** Paste one or two Tencent HTML page URLs → detail (cid) or dual-ep detail (vids). */
  private async openTencentLinks(
    links: Array<{ vid: string; cid: string; url: string }>,
  ): Promise<void> {
    if (!this.cli || !links.length) return
    const generation = ++this.requestGeneration
    this.detailProv = 'tencent'
    const withCid = links.find((l) => l.cid)
    if (withCid?.cid && (links.length === 1 || links.every((l) => !l.vid || l.cid === withCid.cid))) {
      this.detailId = withCid.cid
      await this.detail('tencent', withCid.cid, links.length === 1 ? withCid.vid : '')
      return
    }
    const vids = links.map((l) => l.vid).filter(Boolean)
    if (!vids.length && withCid?.cid) {
      this.detailId = withCid.cid
      await this.detail('tencent', withCid.cid)
      return
    }
    if (!vids.length) {
      this.say('腾讯链接里没有 vid/cid，换一条 HTML 页链接', 'warn')
      this.emit()
      return
    }
    try {
      const input: Record<string, string> =
        vids.length >= 2
          ? { vid: vids[0]!, vid2: vids[1]! }
          : links[0]!.url
            ? { url: links[0]!.url }
            : { vid: vids[0]! }
      if (links[1]?.url && vids.length >= 2) input.url2 = links[1].url
      const data = await this.work(() => this.cli!.invoke('tencent', 'resolve', input))
      if (generation !== this.requestGeneration) return
      const title = asString(data.title) || links[0]!.cid || '腾讯视频'
      this.detailTitle = title
      this.detailId = asString(data.cid) || links[0]!.cid || vids[0]!
      const dualRows: Array<Record<string, unknown>> =
        Array.isArray(data.videos) && data.videos.length >= 2
          ? (data.videos as Array<Record<string, unknown>>)
          : vids.map((vid, i) => ({ vid, title: i === 0 ? title : vid }))
      this.episodeCatalog = []
      this.episodeGroup = ''
      this.eps = dualRows.slice(0, 2).map((row, i) => ({
        vid: asString(row.vid) || vids[i] || '',
        title: asString(row.title) || `视频 ${i + 1}`,
        number: i + 1,
        selected: true,
      }))
      this.detailInfo = {
        title: this.detailTitle,
        desc: links.length >= 2 ? '双链粘贴 · 两个播放目标' : '',
        category: '',
        tags: [],
        score: '',
        episodes: this.eps.length,
        duration: 0,
        vip: false,
        drm: '',
        kind: mediaKindFromMetadata(data) ?? 'show',
        year: 0,
      }
      this.cursor = 0
      this.selectAnchor = 0
      this.probeFailed = false
      this.scene = 'detail'
      this.say(
        links.length >= 2
          ? '已解析两个腾讯播放目标 · 空格可改选，Enter 取双流'
          : `${this.detailTitle} · 1 个视频`,
        'ok',
      )
    } catch (e) {
      if (generation !== this.requestGeneration) return
      this.say(e instanceof Error ? e.message : String(e), 'err')
    }
    this.emit()
  }

  private async detail(provider: string, id: string, focusVid = '', kindHint?: TitleKind): Promise<void> {
    if (!this.cli) return
    const generation = ++this.requestGeneration
    const trimmed = id.trim()
    if (!trimmed || trimmed === '<nil>' || trimmed === 'null') {
      this.say('这条没有剧 ID，换一条', 'warn')
      this.emit()
      return
    }
    const input: Record<string, unknown> = isManifestProvider(provider) && trimmed.startsWith('https://') ? { url: trimmed } : { id: trimmed }
    if (provider === 'hongguo') input.seriesId = trimmed
    else if (provider === 'youku') {
      input.showId = trimmed
      input.all = '1'
      // 详情只用到 is_vip/drm/languages；完整多档画质在进入画质页的 play 里取。
      // 单档 UPS 省掉 detail 里 5 档 + 0280 的隧道往返。
      input.tier = 'single'
    } else if (provider === 'tencent') input.cid = trimmed
    try {
      const data = await this.work(() =>
        isManifestProvider(provider) ? manifestDetail((p,a,i) => this.cli!.invoke(p,a,i), provider, trimmed) : this.cli!.invoke(provider, 'detail', input),
      )
      if (generation !== this.requestGeneration) return
      this.detailTitle = asString(data.title)
      this.episodeCatalog = parseEps(data)
      this.episodeGroup = this.episodeCatalog.find(e => e.vid === focusVid)?.collection ?? episodeCollections(this.episodeCatalog)[0] ?? ''
      this.eps = this.episodeGroup ? this.episodeCatalog.filter(e => e.collection === this.episodeGroup) : this.episodeCatalog
      this.detailInfo = parseDetail(data, provider, this.detailTitle, kindHint)
      await this.applyMovieEditions(provider, data)
      if (generation !== this.requestGeneration) return
      this.cursor = Math.max(0, this.eps.findIndex(e => e.vid === focusVid))
      for (const ep of this.eps) ep.selected = !!focusVid && ep.vid === focusVid
      this.selectAnchor = this.cursor
      this.probeFailed = false
      if (generation !== this.requestGeneration) return
      this.scene = 'detail'
      const n = this.eps.length
      const noun =
        this.detailInfo.kind === 'movie'
          ? n > 1
            ? `${n} 个版本`
            : '电影'
          : `${n} 集`
      this.say(
        n ? `${this.detailTitle} · ${noun} · 回车去画质${data.hasMore === true ? ' · 分页未完整，仅显示已取得分集' : ''}` : '这部没有返回正片',
        n ? 'ok' : 'warn',
      )
    } catch (e) {
      if (generation !== this.requestGeneration) return
      this.say(e instanceof Error ? e.message : String(e), 'err')
    }
    this.emit()
  }

  private async applyMovieEditions(
    provider: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (this.detailInfo?.kind !== 'movie' || isManifestProvider(provider)) return
    const generation = this.requestGeneration
    let play: Record<string, unknown> | undefined
    if (provider === 'youku' && !youkuEditionsFromDetail(data).length) {
      const vid = youkuMoviePick(data)?.vid || ''
      if (vid && this.cli) {
        try {
          play = await this.work(() =>
            this.cli!.invoke('youku', 'play', {
              vid,
              tier: 'single',
              expand: '0',
            }),
          )
          if (generation !== this.requestGeneration) return
        } catch {
          // 正片来自详情 vid，不依赖这次 play。
        }
      }
    }
    if (generation !== this.requestGeneration) return
    const rows = moviePlayables(data, play)
    if (rows.length) {
      const dur = this.eps[0]?.duration
      this.eps = rows.map((e) =>
        dur ? { ...e, duration: e.duration ?? dur } : e,
      )
      return
    }
    if (this.eps.length === 1) {
      this.eps[0].title = this.eps[0].title || '正片'
      this.eps[0].group = 'edition'
    }
  }

  tickQR(): void {
    if (this.scene !== 'qr') return
    void this.pollQR()
  }

  private startQRPoll(): void {
    this.stopQR()
    void this.pollQR()
    this.qrTimer = setInterval(() => {
      void this.pollQR()
    }, this.qrTencent || this.qrTencentDual ? 3500 : 1500)
  }

  private stopQR(): void {
    if (this.qrTimer) {
      clearInterval(this.qrTimer)
      this.qrTimer = null
    }
    this.qrBusy = false
  }

  private cancelQRScene(): void {
    this.providerLoginGeneration++
    this.mewatchQR = false
    this.stopQR()
    this.qrTencent = null
    this.qrTencentDual = false
    this.qrDualDone = { app: false, tv: false }
    this.qrPngPaths = []
    this.qrAscii = ''
  }

  private async pollQR(): Promise<void> {
    if (this.scene !== 'qr' || !this.cli || this.qrBusy) return
    if (this.mewatchQR) { await this.providerLogin({provider:'mewatch',op:'poll'}); return }
    if (!this.qrTencentDual && !this.qrTencent && !this.qrTicket && !this.qrLoginToken) return
    this.qrBusy = true
    try {
      if (this.qrTencentDual) {
        const data = await pollTencentDualQR(this.cli)
        if (this.scene !== 'qr' || !this.qrTencentDual) return
        const mark = (side: 'app' | 'tv', row: Record<string, unknown>) => {
          if (row.logged_in === true) this.qrDualDone[side] = true
          if (row.status === 'expired' || row.status === 'cancelled') {
            this.say(
              side === 'app'
                ? (row.status === 'cancelled' ? 'App 码已取消，请重新双扫' : 'App 码已过期，请重新双扫')
                : (row.status === 'cancelled' ? 'TV 码已取消，请重新双扫' : 'TV 码已过期，请重新双扫'),
              'warn',
            )
          }
        }
        mark('app', data.app)
        mark('tv', data.tv)
        if (this.qrDualDone.app && this.qrDualDone.tv) {
          applyTencentLogin(this.cfg, 'app', data.app)
          applyTencentLogin(this.cfg, 'tv', data.tv)
          this.cfg.tencentMode = 'tv'
          this.persistConfig()
          this.say('App 与 TV 双扫均已登录；会话已写入网关存储，默认播放切到极光 TV', 'ok')
          void this.refreshTencentAccount(false)
          this.scene = 'settings'
          this.qrTencentDual = false
          this.stopQR()
        } else if (this.qrDualDone.app || this.qrDualDone.tv) {
          const done = this.qrDualDone.app ? 'App' : 'TV'
          const wait = this.qrDualDone.app ? 'TV' : 'App'
          this.say(`${done} 已登录 · 仍等待 ${wait} 扫码确认`, 'info')
        } else {
          this.say('等待 App / TV 双扫确认', 'info')
        }
        this.emit()
        return
      }
      if (this.qrTencent) {
        const mode = this.qrTencent
        const data = await pollTencentQR(this.cli, mode)
        if (this.scene !== 'qr' || this.qrTencent !== mode) return
        if (data.logged_in === true) {
          applyTencentLogin(this.cfg, mode, data)
          this.persistConfig()
          this.say(`${tencentLabels[mode]}成功；扫码结果已写入网关存储`, 'ok')
          this.scene = 'settings'; this.stopQR()
        } else if (data.status === 'expired' || data.status === 'cancelled') { this.say(data.status === 'cancelled' ? '已取消授权，请重新出码' : '二维码已过期，请重新扫码', 'warn'); this.stopQR() }
        else this.say(data.status === 'scanned' ? '已扫码，等待手机确认' : '等待扫码确认', 'info')
        this.emit(); return
      }
      const poll = await pollYoukuQR(this.cli, this.qrTicket, this.qrLoginToken)
      this.qrPolls++
      if (poll.sign) {
        this.cfg.youkuSign = poll.sign
        this.persistConfig()
        this.say('已保存 Yk-Sign', 'ok')
        this.scene = 'settings'
        this.stopQR()
        this.emit()
        this.signMissing = false
        this.queueEnsureYouku()
        return
      }
      if (poll.loggedIn && this.cfg.youkuSign) {
        this.say('优酷已登录', 'ok')
        this.scene = 'settings'
        this.stopQR()
        this.emit()
        this.signMissing = false
        this.queueEnsureYouku()
        return
      }
      this.say(`等待扫码确认 · 已轮询 ${this.qrPolls} 次`, 'info')
      this.emit()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (
        this.qrTencentDual &&
        /missing result code|QRCodeStatus|request failed|polling/i.test(msg)
      ) {
        this.say('等待 App / TV 双扫确认（网关轮询中）', 'info')
      } else {
        this.say(msg, 'err')
      }
      this.emit()
    } finally {
      this.qrBusy = false
    }
  }

  private async refreshTencentAccount(announce: boolean): Promise<void> {
    if (!this.cli) {
      if (announce) this.say('未连接网关', 'warn')
      return
    }
    if (announce) {
      this.say('正在查询腾讯账号…')
      this.emit()
    }
    try {
      this.txAcct = await this.work(() => fetchTencentAccount(this.cli!))
      if (announce) {
        this.say(txAccountSummary(this.txAcct), this.txAcct.loggedIn ? 'ok' : 'info')
      }
    } catch (e) {
      if (announce) this.say(e instanceof Error ? e.message : String(e), 'err')
    }
    this.emit()
  }
}

function normKey(name: string, shift?: boolean): string {
  const n = name.toLowerCase()
  if (n === 'return') return 'enter'
  if (n === 'escape') return 'esc'
  if (n === 'arrowup') return 'up'
  if (n === 'arrowdown') return 'down'
  if (n === 'arrowleft') return 'left'
  if (n === 'arrowright') return 'right'
  if (n === 'space') return ' '
  if (shift && name.length === 1) return name.toUpperCase()
  return n
}

/** 网关各 provider 的分页字段不统一：hasMore/more + nextCursor/page。 */
function pageInfo(data: Record<string, unknown>): {
  more: boolean
  cursor: string
} {
  const more =
    asBool(data.hasMore) || asBool(data.more) || asBool(data.has_more)
  const explicit = asString(data.nextCursor)
  const page = anyInt(data.page)
  const cursor =
    explicit && explicit !== '0' ? explicit : page > 0 ? String(page + 1) : ''
  return { more, cursor }
}

function parseSearch(provider: string, data: Record<string, unknown>): Row[] {
  const arr = Array.isArray(data.list)
    ? data.list
    : Array.isArray(data.items)
      ? data.items
      : []
  const seen: Record<string, true> = {}
  const rows: Row[] = []
  for (const it of arr) {
    if (!isObj(it)) continue
    const meta = isObj(it.meta) ? it.meta : {}
    const title =
      firstStr(it, 'title', 'name', 'seriesName') || firstStr(meta, 'title')
    let id =
      firstStr(it, 'seriesId', 'showId', 'cid', 'vid', 'id') ||
      firstStr(meta, 'seriesId', 'showId', 'cid')
    if (id === '<nil>' || id === 'null') id = ''
    const key = `${id}|${title}`
    if ((!title && !id) || seen[key]) continue
    seen[key] = true
    const tags = pickTags(it, meta)
    rows.push({
      title,
      id,
      sub: provider,
      mediaKind: mediaKindFromMetadata(it),
      desc:
        firstStr(it, 'subtitle', 'desc') ||
        firstStr(meta, 'subTitle', 'subtitle', 'desc'),
      score: firstStr(it, 'score') || firstStr(meta, 'score'),
      tags,
    })
  }
  return rows
}

function pickTags(
  item: Record<string, unknown>,
  meta: Record<string, unknown>,
): string[] {
  for (const src of [item, meta]) {
    const raw = src.tags
    if (Array.isArray(raw)) {
      const tags = raw.filter(
        (t): t is string => typeof t === 'string' && t.length > 0,
      )
      if (tags.length) return tags.slice(0, 4)
    }
  }
  return []
}

/** Title-level metadata for the detail screen; every platform fills what it has. */
function parseDetail(
  data: Record<string, unknown>,
  provider: string,
  fallbackTitle: string,
  kindHint?: TitleKind,
): Detail {
  const raw = isObj(data.raw) ? data.raw : {}
  const title = asString(data.title) || asString(raw.title) || fallbackTitle
  const episodeList = Array.isArray(data.episodes) ? data.episodes : []
  const count =
    anyInt(data.episode_count) ||
    anyInt(data.totalEps) ||
    anyInt(raw.episode_count) ||
    episodeList.length
  const drm = isObj(data.drm)
    ? asString(data.drm.note) || asString(data.drm.drm_type)
    : ''
  const tags = pickTags(data, raw)
  const category = asString(data.category) || asString(raw.category)
  const score = asString(data.score) || asString(raw.score)
  return {
    title,
    desc:
      asString(data.desc) ||
      asString(raw.desc) ||
      asString(data.intro) ||
      asString(data.description),
    category,
    tags,
    score,
    episodes: count,
    duration: anyInt(data.duration) || anyInt(raw.duration),
    vip: data.is_vip === true || raw.is_vip === true,
    drm,
    kind: mediaKindFromMetadata(data) ?? kindHint ?? 'show',
    year: anyInt(data.year) || anyInt(raw.year),
  }
}
