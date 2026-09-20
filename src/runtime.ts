import { startTencentQR, pollTencentQR, tencentLabels, tencentPlayInput, type TencentMode } from './lib/tencent-qr.ts'
import { Discovery, discoveryRows } from './lib/discovery'
import { Navigation, moveCursor } from './lib/navigation'
import { DownloadDraft } from './lib/download-draft'
import { gridWindow } from './lib/grid'
import { isDtsAudio } from './lib/mp4box'
import { wrapLines } from './lib/text'
import { demoSnapshot } from './lib/demo'
import { demoInvoke } from './lib/discovery-demo'
import { appendFileSync } from 'node:fs'
import {
  clampThreads,
  loadConfig,
  saveConfig,
  type FileConfig,
} from './lib/config.ts'
import { GwClient, ReloginRequired, type KeyInfo } from './lib/client.ts'
import {
  JobHub,
  jobTitle,
  nextJobID,
  patchJob,
  type DlTask,
} from './lib/jobs.ts'
import { moviePlayables, probeOptions, youkuEditionsFromDetail } from './lib/quality.ts'
import { runTunnel } from './lib/tunnel.ts'
import {
  hostIsLocal,
  importYoukuCookie,
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
import { tmdbSearch } from './lib/tmdb.ts'
import { clipTitle, extractDouyinURL, extractYoukuVideoId } from './lib/link.ts'
import { pickDouyinURL, pickURL } from './lib/media.ts'
import { filename, sourceTag, dots, tierHeight } from './lib/name.ts'
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

const ALL_PROVIDERS = ['youku', 'tencent', 'hongguo', 'douyin']

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
  private cfg: FileConfig
  private cli: GwClient | null = null
  private keyInfo: KeyInfo | null = null
  snapshot!: Snapshot
  private scene: Scene
  private status = ''
  /** Lets the shell color a message instead of guessing from its text. */
  private statusKind: StatusKind = 'info'
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
  /** 最近一次取流带回来的权益真相（play 的 quality_gate）。 */
  private vipProbe: VipProbe | null = null
  /** 本机 Yk-Sign 已不在网关凭证库里（cred info 报 not found/revoked/invalid）。 */
  private signMissing = false
  private tmdbHits: TMDBHit[] = []
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
  private requestGeneration = 0
  private searching = false
  private pageLoading = false
  private readonly simulated: boolean
  private detailCursor = 0
  private detailTitle = ''
  private detailId = ''
  private detailProv = ''
  private qrAscii = ''
  private qrPngPaths: string[] = []
  private qrTencent: TencentMode | null = null
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
          hongguoMerge: true,
          hongguoNfo: true,
          hongguoFmt: 'mkv',
          threads: 4,
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
      const line = [e.status, e.err || e.log].filter(Boolean).join(' · ')
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
      this.cli = new GwClient(this.cfg.host, this.cfg.key)
      this.scene = 'home'
    }
    if (this.simulated) {
      this.cli = new GwClient(this.cfg.host, this.cfg.key)
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
    if (this.simulated) void this.discovery.open('youku')
    else void this.boot()
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
    if (mods.alt && ['1', '2', '3'].includes(k)) {
      const p = ['youku', 'tencent', 'hongguo'][Number(k) - 1]
      if (this.has(p)) {
        this.requestGeneration++
        this.searching = false
        this.navigation.clear()
        this.draft.clear()
        this.provIdx = this.providers().indexOf(p)
        if (this.scene !== 'search') {
          this.scene = 'workspace'
          void this.discovery.open(p, this.discovery.view.mode)
        } else {
          void this.discovery.open(p, this.discovery.view.mode)
        }
      } else this.say('当前 Key 没有这个平台权限', 'warn')
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
      ['help', 'jobs', 'settings', 'results'].includes(this.scene)
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
        }
        break
      case 'help':
        this.cursor = moveCursor(
          this.cursor,
          k,
          18,
          Math.max(1, this.viewport.height - 4),
        )
        break
      case 'job-detail':
        if (k === 'esc') {
          this.scene = 'jobs'
        } else
          this.logOffset = moveCursor(
            this.logOffset,
            k,
            this.jobLines().length,
            Math.max(1, this.viewport.height - 6),
          )
        break
      case 'search':
        this.updateSearch(k)
        break
      case 'results':
        this.updateResults(k)
        break
      case 'detail':
        this.updateDetail(k)
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
          this.cursor = moveCursor(
            this.cursor,
            k,
            this.jobs.length,
            this.viewport.height - 6,
          )
        break
      case 'settings':
        this.updateSettings(k)
        break
      case 'qr':
        if (k === 'esc') {
          this.stopQR()
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

  private emit(): void {
    this.snapshot = this.build()
    for (const fn of this.listeners) fn(this.snapshot)
    trace(
      `emit scene=${this.scene} busy=${this.busy} tunnel=${this.tunnelOk} status=${this.status}`,
    )
  }

  /** Update the status line and how the shell should read it. */
  private say(message: string, kind: StatusKind = 'info'): void {
    this.status = message
    this.statusKind = kind
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
    if (this.has('douyin') || this.has('youku')) items.push('粘贴链接')
    items.push('搜索')
    if (this.has('hongguo') || this.has('youku') || this.has('tencent'))
      items.push('榜单')
    items.push('任务', '设置')
    return items
  }

  private settingFields(): string[] {
    const f = ['隧道', '网关', 'Key', '下载目录', '下载线程']
    if (this.has('youku') || this.has('tencent') || this.has('hongguo'))
      f.push('发布组')
    if (this.has('youku') || this.has('tencent')) f.push('TMDB Key')
    if (this.has('youku')) f.push('优酷扫码', '优酷 Cookie', '优酷登录')
    if (this.has('tencent')) f.push('腾讯登录方式', '腾讯扫码', '腾讯 Cookie')
    if (this.has('hongguo')) f.push('红果合并', '红果 NFO', '红果封装')
    return f
  }

  private settingValue(f: string): string {
    if (Object.values(tencentLabels).includes(f)) return '独立扫码 · 不覆盖其他 Cookie'
    if (f === '腾讯登录方式') return ({cookie:'手动 Cookie',web:'网页 QQ',app:'腾讯 App（网页授权）',tv:'极光 TV'} as const)[this.cfg.tencentMode || 'cookie']
    if (f === '腾讯扫码') return this.cfg.tencentMode === 'cookie' || !this.cfg.tencentMode ? '先选择扫码登录方式' : '回车出码 · 会话独立保存'
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
          return `已连接 · 优酷/腾讯走本机 IP · ${via}`
        }
        if (this.tunnelErr) return `断开  ${this.tunnelErr}`
        return '未连接'
      case '网关':
        return this.cfg.host
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
      case '优酷 Cookie':
        return '粘贴浏览器 Cookie（含 P_sck）'
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
      case '红果合并':
        return this.cfg.hongguoMerge ? '开' : '关'
      case '红果 NFO':
        return this.cfg.hongguoNfo ? '开' : '关'
      case '红果封装':
        return this.cfg.hongguoFmt
      default:
        return ''
    }
  }

  private editSeed(f: string): string {
    if (f === '腾讯 TV 设备 ID') return this.cfg.tencentTVDevice || ''
    if (f === '腾讯 TV QUA') return this.cfg.tencentTVQUA || ''
    if (f === '腾讯 TV 版本') return this.cfg.tencentTVVersion || ''

    switch (f) {
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
      case '腾讯 Cookie':
        return this.cfg.tencentCookie
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
      qualities: this.qualities,
      audios: this.audios.map((a) => ({ ...a })),
      tmdbHits: this.tmdbHits,
      jobs: this.jobs,
      settings: this.settingFields().map((label) => ({
        label,
        value: this.settingValue(label),
      })),
      detail: this.detailInfo ?? undefined,
      detailTitle: this.detailTitle,
      pendingCount: this.pending.length,
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
        if (!this.tunnelOn && (this.has('youku') || this.has('tencent'))) {
          this.tunnelOn = true
          this.tunnelAbort = new AbortController()
          // A tunnel that is torn down and redialled every few seconds must not
          // own the status line: the header dot already shows the live state, so
          // only the first drop is announced, and recovery only after a real gap.
          let announcedDrop = false
          let downSince = 0
          runTunnel(
            this.cfg.host,
            this.cfg.key,
            (ok, err, transport) => {
              if (this.abort.signal.aborted) return
              const wasUp = this.tunnelOk
              this.tunnelOk = ok
              this.tunnelErr = err
              if (transport) this.tunnelTransport = transport
              if (ok) {
                if (downSince && Date.now() - downSince > 8000)
                  this.say('隧道已恢复：优酷/腾讯走本机 IP', 'ok')
                downSince = 0
                announcedDrop = false
                // account/profile 必须走当前 Key 自己的隧道；等 OPEN 后再查。
                if (!wasUp) this.queueEnsureYouku()
              } else {
                downSince ||= Date.now()
                if (!announcedDrop) {
                  announcedDrop = true
                  this.say(
                    err === 'closed'
                      ? '隧道断开，自动重连中（优酷/腾讯暂时走本机 IP）'
                      : `隧道断开 ${err}`,
                    'warn',
                  )
                }
              }
              this.emit()
            },
            this.tunnelAbort.signal,
          )
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
    this.cli = new GwClient(this.cfg.host, this.cfg.key)
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
    return job
      ? [
          job.title,
          `状态 ${job.status} · ${Math.round(job.pct * 100)}%`,
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
    return {
      title: first?.series || first?.title || this.detailTitle,
      episodes: this.pending.map((t) => String(t.episode || 1)).join(', '),
      quality:
        this.qualities[this.qIdx]?.label ||
        first?.quality ||
        '平台提供的单一视频流',
      audio:
        this.audios
          .filter((a) => a.selected)
          .map((a) => [a.lang !== '—' ? a.lang : '', a.label].filter(Boolean).join(' '))
          .join(' / ') || '平台默认',
      directory: this.cfg.outDir,
      name: first
        ? filename({
            kind:
              first.kind ||
              (first.provider === 'hongguo' || first.provider === 'douyin'
                ? 'short'
                : 'show'),
            title: first.series || first.title,
            nameDots: first.nameDots,
            year: first.year,
            season: first.season,
            episode: first.episode,
            height: first.height,
            codec: first.codec || 'H264',
            edition: first.edition,
            source: sourceTag(first.provider),
            group:
              first.provider === 'douyin'
                ? ''
                : first.group || this.cfg.releaseGroup,
            tmdbId: first.tmdbId,
            container:
              first.provider === 'douyin' ||
              (first.provider === 'youku' &&
                first.audioTracks?.some(isDtsAudio))
                ? 'mp4'
                : first.provider === 'hongguo'
                  ? this.cfg.hongguoFmt
                  : 'mkv',
          })
        : '',
    }
  }
  private updateWorkspace(k: string, _shift?: boolean) {
    if (!this.providers().includes(this.discovery.view.provider)) {
      this.say('当前 Key 无此平台权限', 'warn')
      return
    }
    const v = this.discovery.view,
      sections = this.discovery.visibleSections
    if (k === 'esc' && v.focus === 'sections') {
      v.focus = 'list'
      return
    }
    if (k === 'tab') {
      v.focus = v.focus === 'sections' ? 'list' : 'sections'
      return
    }
    if ((k === 'left' || k === 'right') && v.focus === 'sections') {
      void this.discovery
        .open(v.provider, v.mode === 'home' ? 'rank' : 'home')
        .then(() => {
          this.discovery.view.focus = 'sections'
          this.emit()
        })
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
    if (k === 'f' && this.discovery.section?.filters?.length) {
      this.filterIndex = 0
      this.scene = 'filters'
      return
    }
    if (v.focus === 'sections') {
      if (['down', 'up', 'home', 'end', 'pageup', 'pagedown'].includes(k)) {
        const index = moveCursor(
          v.sectionIndex,
          k,
          sections.length,
          sections.length,
        )
        void this.discovery.choose(index)
      } else if (k === 'enter') v.focus = 'list'
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
    if(target?.type==='video'&&row.sub==='youku'){await this.downloadYoukuLink(target.id||row.id);return}
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
    await this.detail(row.sub, this.detailId)
    if (this.scene === origin && this.requestGeneration === generation + 1)
      this.navigation.pop()
  }

  private updateSearch(k: string): void {
    if (k === 'esc') {
      this.back()
      return
    }
    if (k !== 'enter' || this.searching) return
    const query = this.query.trim(),
      p = this.providers()[this.provIdx]
    if (!query || !p) {
      this.say('请选择有权限的平台并输入关键词', 'warn')
      return
    }
    const yk = extractYoukuVideoId(query),
      dy = extractDouyinURL(query)
    if (yk) {
      void this.downloadYoukuLink(yk)
      return
    }
    if (dy) {
      void this.downloadDouyin('', '', dy)
      return
    }
    void this.search(p, query)
  }

  private updateResults(k: string): void {
    if (k === 'esc') {
      this.back()
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

  private updateDetail(k: string): void {
    const n = this.eps.length
    if (!n) {
      if (k === 'esc') this.back()
      return
    }
    if (k === 'esc') {
      this.back()
      return
    }
    if (this.detailProv === 'douyin' && (k === 'enter' || k === 'd')) {
      this.scene = 'quality'
      return
    }
    if (k === 'left' || k === 'h') this.cursor = Math.max(0, this.cursor - 1)
    else if (k === 'right' || k === 'l')
      this.cursor = Math.min(n - 1, this.cursor + 1)
    else if (
      ['down', 'up', 'pageup', 'pagedown', 'home', 'end', 'j', 'k'].includes(k)
    )
      this.cursor = moveCursor(
        this.cursor,
        k === 'j' ? 'down' : k === 'k' ? 'up' : k,
        n,
        this.viewport.height - 8,
        this.isMovie()
          ? 1
          : gridWindow(n, this.cursor, this.viewport.width - 2, 1).perRow,
      )
    else if (k === ' ' || k === 'space')
      this.eps[this.cursor].selected = !this.eps[this.cursor].selected
    else if (k === 'a') {
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
          this.viewport.height - 9,
        )
      else this.qIdx = moveCursor(this.qIdx, k, n, this.viewport.height - 9)
      this.syncEmbeddedAudio()
      return
    }
    if (k === 'j' || k === 'down') {
      if (onAudio) this.audioIdx = (this.audioIdx + 1) % n
      else this.qIdx = (this.qIdx + 1) % n
    } else if (k === 'k' || k === 'up') {
      if (onAudio) this.audioIdx = (this.audioIdx - 1 + n) % n
      else this.qIdx = (this.qIdx - 1 + n) % n
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
    const tracks = (
      picked.length
        ? picked
        : this.audios.filter((a) => a.isDefault).slice(0, 1)
    ).filter(a => !a.embedded).map((a) => ({
      id: a.id,
      label: a.label,
      lang: a.lang,
      vid: a.vid,
    }))
    const a = this.audios[this.audioIdx]
    for (const t of this.pending) {
      if (q) {
        t.quality = q.id
        t.group = this.cfg.releaseGroup
        if (q.height > 0) t.height = q.tier || (t.provider === 'hongguo' && q.width > 0 && q.height > q.width
          ? tierHeight(q.height, q.width) : tierHeight(q.width, q.height))
        if (q.codec) t.codec = q.codec
      }
      t.audioTracks = tracks
    }
    this.probeFailed = false
    if (q)
      this.say(
        a ? `画质 ${q.label} · 音轨 ${a.label}` : `画质 ${q.label}`,
        'ok',
      )
  }

  private updateTMDB(k: string): void {
    if (k === 'r') {
      void this.afterQuality()
      return
    }
    if (k === 'esc') {
      this.scene = 'quality'
      return
    }
    if (k === 's') {
      this.scene = 'confirm'
      return
    }
    if (this.tmdbHits.length && (k === 'j' || k === 'down'))
      this.cursor = (this.cursor + 1) % this.tmdbHits.length
    else if (this.tmdbHits.length && (k === 'k' || k === 'up'))
      this.cursor =
        (this.cursor - 1 + this.tmdbHits.length) % this.tmdbHits.length
    else if (k === 'enter' && this.tmdbHits[this.cursor]) {
      const h = this.tmdbHits[this.cursor]
      for (const t of this.pending) {
        t.tmdbId = h.id
        t.year = h.year
        t.nameDots = dots(h.name)
        t.plot = h.overview ?? ''
        if (h.name) t.series = h.name
      }
      this.scene = 'confirm'
    }
  }

  private persistConfig() {
    if (!this.simulated) saveConfig(this.cfg)
  }

  private updateSettings(k: string): void {
    const fields = this.settingFields()
    if (k === 'esc') {
      this.back()
      if (!this.simulated) this.persistConfig()
      return
    }
    if (fields.length && (k === 'j' || k === 'down'))
      this.setIdx = (this.setIdx + 1) % fields.length
    else if (fields.length && (k === 'k' || k === 'up'))
      this.setIdx = (this.setIdx - 1 + fields.length) % fields.length
    else if (k === 'enter' || k === ' ' || k === 'space') {
      if (fields[this.setIdx]) void this.openSetting(fields[this.setIdx])
    }
  }

  private updateEdit(k: string): void {
    if (k === 'esc') {
      this.scene = this.editField === '确认下载目录' ? 'confirm' : 'settings'
      return
    }
    if (k === 'enter') void this.commitEdit(this.editValue.trim())
  }

  private async openSetting(f: string): Promise<void> {
    if (
      this.simulated &&
      [
        '网关',
        'Key',
        '优酷登录',
        '优酷扫码',
        '优酷 Cookie',
        '腾讯 Cookie', '腾讯扫码',
      ].includes(f)
    ) {
      this.say('离线演示不连接账号服务；可测试目录、命名和封装设置')
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
    if (f === '腾讯登录方式') {
      const modes = ['cookie','web','app','tv'] as const
      this.cfg.tencentMode = modes[(modes.indexOf(this.cfg.tencentMode || 'cookie')+1)%modes.length]
      this.persistConfig(); this.emit(); return
    }
    if (f === '腾讯扫码' && (!this.cfg.tencentMode || this.cfg.tencentMode === 'cookie')) { this.say('先在腾讯登录方式选择网页 QQ 或极光 TV', 'info'); this.emit(); return }
    const txMode = f === '腾讯扫码' ? this.cfg.tencentMode as TencentMode : undefined
    if (txMode && this.cli) {
      this.stopQR()
      this.qrTencent = txMode
      this.qrHint = txMode === 'web' ? '手机 QQ 扫码（网页方式历史上有风控）；独立保存网页会话' : txMode === 'tv' ? '云视听极光扫码；独立保存 TV 会话' : '腾讯视频 App 扫码；保存网页授权，手机播放尚未适配'
      try {
        const path = await this.work(() => startTencentQR(this.cli!, this.cfg, txMode))
        this.qrPngPaths = [path]; this.qrAscii = ''; this.scene = 'qr'
        this.say('二维码已保存本机；扫码不会修改手贴 Cookie', 'info')
        this.startQRPoll()
      } catch(e) { this.say(e instanceof Error ? e.message : String(e), 'err') }
      this.emit(); return
    }
    if (f === '优酷扫码') {
      this.qrTencent = null
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
      this.say('登录态由扫码或导入 Cookie 写入，不能手改。', 'warn')
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
    this.editField = f
    this.editValue = this.editSeed(f)
    this.scene = 'edit'
    this.emit()
  }

  private async commitEdit(v: string): Promise<void> {
    if (this.editField === '确认下载目录') {
      if (!v) {
        this.say('下载目录不能为空', 'warn')
        return
      }
      this.cfg.outDir = v
      this.scene = 'confirm'
      this.emit()
      return
    }
    switch (this.editField) {
      case '网关':
        this.discovery.clear()
        this.keyInfo = null
        this.cfg.host = v.replace(/\/+$/, '')
        if (this.cfg.key) this.cli = new GwClient(this.cfg.host, this.cfg.key)
        this.persistConfig()
        this.scene = 'settings'
        await this.refreshKey()
        return
      case 'Key':
        this.discovery.clear()
        this.keyInfo = null
        this.cfg.key = v
        this.cli = new GwClient(this.cfg.host, this.cfg.key)
        this.persistConfig()
        this.scene = 'settings'
        await this.refreshKey()
        return
      case '下载目录':
        this.cfg.outDir = v
        break
      case '下载线程':
        this.cfg.threads = clampThreads(v)
        break
      case '发布组':
        this.cfg.releaseGroup = v
        break
      case 'TMDB Key':
        this.cfg.tmdbKey = v
        break
      case '腾讯 TV 设备 ID': this.cfg.tencentTVDevice = v; break
      case '腾讯 TV QUA': this.cfg.tencentTVQUA = v; break
      case '腾讯 TV 版本': this.cfg.tencentTVVersion = v; break
      case '腾讯 Cookie':
        this.cfg.tencentCookie = v
        break
      case '优酷 Cookie':
        if (!v) {
          this.say('Cookie 为空', 'warn')
          this.scene = 'settings'
          this.emit()
          return
        }
        if (!this.cli) return
        this.scene = 'settings'
        this.say('正在导入优酷 Cookie…')
        this.emit()
        try {
          const imported = await this.work(() =>
            importYoukuCookie(this.cli!, v),
          )
          this.cfg.youkuSign = imported.sign
          this.persistConfig()
          this.signMissing = false
          this.ykLogin = null
          this.ykAcct = imported.accountInfo
            ? parseYkAccount(imported.accountInfo)
            : null
          if (this.ykAcct) {
            this.ykLogin = await ykLoginInfo(this.cli, this.cfg.youkuSign)
            this.say(
              `优酷 Cookie 已导入 · ${accountSummary(this.ykAcct)}`,
              this.ykAcct.needsScan ? 'warn' : 'ok',
            )
          } else if (this.tunnelOk) {
            await this.ensureYouku()
            const account = this.ykAcct as YkAccount | null
            this.say(
              `优酷 Cookie 已导入 · ${accountSummary(account)}`,
              account?.needsScan ? 'warn' : 'ok',
            )
          } else {
            this.say('优酷 Cookie 已导入，等待隧道连接后查询账户', 'ok')
            this.queueEnsureYouku()
          }
        } catch (e) {
          this.say(
            `Cookie 导入失败：${e instanceof Error ? e.message : e}`,
            'err',
          )
        }
        this.emit()
        return
    }
    this.persistConfig()
    this.say(`${this.editField} 已保存`, 'ok')
    this.scene = 'settings'
    this.emit()
  }

  private isMovie(): boolean {
    return this.detailInfo?.kind === 'movie'
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
      series: this.detailTitle,
      vid: ep.vid,
      season: movie ? 0 : 1,
      episode: movie ? 0 : ep.number || i + 1,
      height: 0,
      quality: '',
      group: this.cfg.releaseGroup,
      codec: '',
      tmdbId: 0,
      nameDots: '',
      year: this.detailInfo?.year ?? 0,
      plot: '',
      kind: movie ? 'movie' : 'show',
      edition: movie && ep.title && ep.title !== '正片' ? ep.title : '',
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
        const first = this.pending[0]
        const result = await this.work(() =>
          this.cli!.invoke(
            'tencent',
            'play',
            { vid: first.vid, defn: first.quality, ...tencentPlayInput(this.cfg) },
            this.cli!.extra(this.cfg, 'tencent'),
          ),
        )
        if (generation !== this.requestGeneration) return
        if (!pickURL(result)) throw new Error('选定画质没有返回可用视频地址')
      } catch (e) {
        if (generation !== this.requestGeneration) return
        this.searching = false
        this.say(
          `选定画质探测失败：${e instanceof Error ? e.message : e} · Enter 重试 / Esc 返回`,
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
      try {
        const hits = await tmdbSearch(
          this.cfg.tmdbKey,
          this.cfg.tmdbLang,
          this.detailTitle,
          !this.isMovie(),
        )
        if (generation !== this.requestGeneration) return
        {
          this.tmdbHits = hits.map((h) => ({
            id: h.id,
            name: h.name || h.title,
            title: h.title,
            year: h.year,
            overview: h.overview,
          }))
          this.cursor = 0
          this.scene = 'tmdb'
          this.searching = false
          this.emit()
          return
        }
      } catch (e) {
        if (generation !== this.requestGeneration) return
        this.tmdbHits = []
        this.cursor = 0
        this.scene = 'tmdb'
        this.searching = false
        this.say(
          `TMDB: ${e instanceof Error ? e.message : e} · S 跳过 / R 重试`,
          'warn',
        )
        this.emit()
        return
      }
    }
    if (generation !== this.requestGeneration) return
    this.searching = false
    this.scene = 'confirm'
    this.emit()
  }

  private enqueueAll(tasks: DlTask[]): void {
    if (!this.cli || !tasks.length) return
    for (const t of tasks) {
      const id = nextJobID()
      this.jobs.push({
        id,
        title: jobTitle(t),
        status: '排队',
        pct: 0,
        log: '',
        err: '',
      })
      if (!this.simulated) this.hub.enqueue({ ...this.cfg }, this.cli, id, t)
    }
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

  private async downloadYoukuLink(vid: string): Promise<void> {
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
    this.detailTitle = asString(data.title) || `优酷视频 ${vid}`
    this.detailInfo = parseDetail(data, 'youku', this.detailTitle)
    const episode = parseEps(data).find((ep) => ep.vid === vid)
    this.eps = [
      episode ?? { vid, title: this.detailTitle, number: 1, selected: true },
    ]
    this.cursor = 0
    this.probeFailed = false
    this.pushNavigation(origin, originCursor)
    this.scene = 'detail'
    this.eps[0].selected = true
    this.emit()
  }

  private async detail(provider: string, id: string): Promise<void> {
    if (!this.cli) return
    const generation = ++this.requestGeneration
    const trimmed = id.trim()
    if (!trimmed || trimmed === '<nil>' || trimmed === 'null') {
      this.say('这条没有剧 ID，换一条', 'warn')
      this.emit()
      return
    }
    const input: Record<string, unknown> = { id: trimmed }
    if (provider === 'hongguo') input.seriesId = trimmed
    else if (provider === 'youku') {
      input.showId = trimmed
      input.all = '1'
    } else if (provider === 'tencent') input.cid = trimmed
    try {
      const data = await this.work(() =>
        this.cli!.invoke(provider, 'detail', input),
      )
      if (generation !== this.requestGeneration) return
      this.detailTitle = asString(data.title)
      this.eps = parseEps(data)
      this.detailInfo = parseDetail(data, provider, this.detailTitle)
      await this.applyMovieEditions(provider, data)
      if (generation !== this.requestGeneration) return
      this.cursor = 0
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
        n ? `${this.detailTitle} · ${noun}` : '这部没有返回正片',
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
    if (this.detailInfo?.kind !== 'movie') return
    const generation = this.requestGeneration
    let play: Record<string, unknown> | undefined
    if (provider === 'youku' && !youkuEditionsFromDetail(data).length) {
      const vid = this.eps[0]?.vid || asString(data.vid)
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
    }, this.qrTencent ? 3500 : 1500)
  }

  private stopQR(): void {
    if (this.qrTimer) {
      clearInterval(this.qrTimer)
      this.qrTimer = null
    }
    this.qrBusy = false
  }

  private async pollQR(): Promise<void> {
    if (this.scene !== 'qr' || !this.cli || this.qrBusy) return
    if (!this.qrTencent && !this.qrTicket && !this.qrLoginToken) return
    this.qrBusy = true
    try {
      if (this.qrTencent) {
        const mode = this.qrTencent
        const data = await pollTencentQR(this.cli, mode)
        if (this.scene !== 'qr' || this.qrTencent !== mode) return
        if (data.logged_in === true) {
          this.say(`${tencentLabels[mode]}成功；当前登录方式已选择该独立会话`, 'ok')
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
      this.say(e instanceof Error ? e.message : String(e), 'err')
      this.emit()
    } finally {
      this.qrBusy = false
    }
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
    kind: /电影/.test(category) ? 'movie' : 'show',
    year: anyInt(data.year) || anyInt(raw.year),
  }
}

function parseEps(data: Record<string, unknown>): Episode[] {
  const arr = Array.isArray(data.episodes) ? data.episodes : []
  const eps: Episode[] = []
  for (const [i, it] of arr.entries()) {
    if (!isObj(it)) continue
    let n = i + 1
    if (typeof it.ep === 'number') n = it.ep
    else if (typeof it.number === 'number') n = it.number
    else if (typeof it.number === 'string') {
      const x = Number.parseInt(it.number, 10)
      if (Number.isFinite(x)) n = x
    } else if (typeof it.stage === 'string') {
      const x = Number.parseInt(it.stage, 10)
      if (Number.isFinite(x)) n = x
    }
    const kind = firstStr(it, 'kind', 'group')
    if (/预告|预约|trailer|advert/i.test(kind) || it.is_trailer === true)
      continue
    eps.push({
      title: firstStr(it, 'title', 'name'),
      vid: firstStr(it, 'vid', 'id'),
      number: n,
      selected: false,
      duration:
        anyInt(it.duration) ||
        anyInt(it.duration_ms ? Number(it.duration_ms) / 1000 : 0) ||
        undefined,
      group: firstStr(it, 'kind', 'group', 'stage'),
    })
  }
  return eps
}
