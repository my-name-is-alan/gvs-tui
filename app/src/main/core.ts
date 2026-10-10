import { createHash } from 'node:crypto'
import { userMessage, errorCode } from '@tui/user-message.ts'
import { ProviderSessions, type SessionCommand, type ProviderSessionView } from '@tui/provider-session.ts'
import { supportsSearch, supportsBrowse, isManifestProvider } from '@tui/providers.ts'
import { manifestDetail } from '@tui/manifest-detail.ts'
import { providerLink } from '@tui/manifest-provider.ts'
import { readTencentDiagnostics, tencentDiagnosticJobID } from '@tui/tencent-diagnostics.ts'
import { needsTunnel } from '@tui/tunnel-policy.ts'
import { parseEpisodes as parseEps } from '@tui/episodes.ts'
// 桌面端业务核心：把 tui/src/lib 的能力编排成界面可调用的方法。
// 流程与 TUI runtime.ts 保持一致（探测 → 选画质/音轨 → TMDB → 入队），
// 只是去掉了按键状态机，改成显式参数。
import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import QRCode from 'qrcode'
import { GwClient, ReloginRequired, type KeyInfo } from '@tui/client.ts'
import { selectAudioTracks } from '@tui/audio-selection.ts'
import { clampThreads, loadConfig, normalizeOutDir, saveConfig, type FileConfig } from '@tui/config.ts'
import { hasLocalCredentials, migrateLocalCredentials, pushLocalCredential } from '@tui/vault-migrate.ts'
import { fallbackSections } from '@tui/discovery.ts'
import {
  JobHub,
  bindYoukuAudioTracksToTask,
  discardJobWork,
  jobWorkDir,
  jobNaming,
  nextJobID,
  seedJobID,
  tmpRoot,
  type DlTask,
  type JobEvt,
} from '@tui/jobs.ts'
import { extractTencentLinks, extractYoukuVideoId, extractIQLink, extractIQCNLink } from '@tui/link.ts'
import { youkuSpokenLangKey } from '@tui/media.ts'
import { completedFilename, filename, folder, tierHeight, dots } from '@tui/name.ts'
import { usesMeasuredNaming } from '@tui/completed-naming.ts'
import { moviePlayables, probeOptions, qualityChoiceLabel, youkuEditionsFromDetail, youkuMoviePick } from '@tui/quality.ts'
import { selectedTencentQuality } from '@tui/tencent-quality-selection.ts'
import { selectedIQCNQuality, restoreIQCNSourceHints } from '@tui/iqcn-quality-selection.ts'
import { runLog } from '@tui/runlog.ts'
import { applyTencentLogin, pollTencentDualQR, tencentTVLoginInput } from '@tui/tencent-qr.ts'
import { fetchTencentAccount, txAccountSummary, type TxAccount } from '@tui/tencent-account.ts'
import { tmdbSearch, tmdbSeasons } from '@tui/tmdb.ts'
import { mediaKindFromMetadata, movieEdition } from '@tui/media-kind.ts'
import { parseSeriesTitle, seriesSeason, tmdbSeasonOverride } from '@tui/series-title.ts'
import { ensureTools, lookBundledFFmpeg, lookMP4Box, lookMkvmerge, lookM3u8dl } from '@tui/tools.ts'
import { runTunnel } from '@tui/tunnel.ts'
import { anyInt, asString, isObj } from '@tui/util.ts'
import { pollYoukuQR } from '@tui/youku-qr.ts'
import {
  accountSummary,
  ykAccount,
  ykLoginInfo,
  ykRefresh,
  shouldRefreshYouku,
  type YkAccount,
  type YkLogin,
} from '@tui/youku-session.ts'
import type { Audio, Episode, Quality, VipProbe } from '../../../src/types.ts'
import {
  PROVIDERS,
  type AccountView,
  type AppState,
  type AudioView,
  type BrowseResult,
  type Card,
  type DetailView,
  type DetailHint,
  type EnqueueRequest,
  type EpisodeView,
  type JobView,
  type LinkTarget,
  type NamingPreview,
  type ProbeResult,
  type Provider,
  type QRPoll,
  type QRStart,
  type QualityView,
  type SearchGroup,
  type Section,
  type SettingsPatch,
  type SettingsView,
  type TmdbHit,
  type Tone,
} from '@shared/api'
import { installTunnelWebSocket } from './env'
import { desktopProxy, setDesktopProxy } from './desktop-network'
import { normalizeDesktopProxy } from './desktop-proxy'
import { detailPoster, posterOf, toCards } from './cards'
import { clearPosterCache, posterCacheSize } from './posters'

const SIGN_DEAD_RE = /not found|revoked|invalid Yk-Sign|yk_sign not found/i

type Emit = {
  state: () => void
  jobs: (jobs: JobView[]) => void
  toast: (message: string, tone: Tone) => void
}

/** 任务是按 pin 里的配置跑的，所以显示的路径也用 pin，别串到用户后来改的设置上。 */
type JobRecord = { view: JobView; task: DlTask; pin: Pin }

/** 入队那一刻钉住的配置：继续下载要写回同样的路径与分片布局。key / cookie / sign 永不落盘。 */
export type Pin = {
  hamiClient?: 'tv' | 'web'
  outDir: string
  tmpDir: string
  threads: number
  releaseGroup: string
  hongguoFmt: string
  huangguoFmt: string
  hongguoNfo: boolean
  huangguoNfo: boolean
}

/** jobs.json：重启后把排队/进行中的任务还成「已暂停」。 */
type JobsFile = { version: 1; jobs: Array<{ view: JobView; task: DlTask; pin: Pin }> }
const JOBS_VERSION = 1

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

function pinOf(cfg: FileConfig): Pin {
  return {
    hamiClient: cfg.hamiClient || 'tv',
    outDir: cfg.outDir,
    tmpDir: cfg.tmpDir,
    threads: cfg.threads,
    releaseGroup: cfg.releaseGroup,
    hongguoFmt: cfg.hongguoFmt,
    huangguoFmt: cfg.huangguoFmt,
    hongguoNfo: cfg.hongguoNfo,
    huangguoNfo: cfg.huangguoNfo,
  }
}

/**
 * 临时目录：空 = 自动（放在下载目录所在的盘）。
 * 填了就归一成绝对路径，并且当场验证能建、能写——不然要等到下载到一半才报错。
 */
function normalizeTmpDir(raw: string): string {
  const v = (raw ?? '').trim()
  if (!v) return ''
  const abs = resolve(v)
  try {
    mkdirSync(abs, { recursive: true })
    const probe = join(abs, `.gvs-write-test-${process.pid}`)
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
  } catch (e) {
    throw new Error(`临时目录不可写：${abs}（${e instanceof Error ? e.message : String(e)}）`)
  }
  return abs
}

/** 某目录下的直接子项大小（目录递归，符号链接不跟随）。 */
function treeSize(path: string): number {
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(path)
  } catch {
    return 0
  }
  if (!st.isDirectory()) return st.size
  let total = 0
  let names: string[] = []
  try {
    names = readdirSync(path)
  } catch {
    return 0
  }
  for (const n of names) total += treeSize(join(path, n))
  return total
}

function toEpisodeView(e: Episode): EpisodeView {
  return {
    vid: e.vid,
    tencentPlayParams: e.tencentPlayParams,
    season: e.season,
    title: e.title,
    number: e.number,
    group: e.group ?? '',
    collection: e.collection,
    duration: e.duration ?? 0,
    languages: e.languages ?? [],
  }
}

/** runtime.ts parseEps */

function pickTags(...srcs: Array<Record<string, unknown>>): string[] {
  for (const src of srcs) {
    if (Array.isArray(src.tags)) {
      const tags = src.tags.filter((t): t is string => typeof t === 'string' && t.length > 0)
      if (tags.length) return tags.slice(0, 4)
    }
  }
  return []
}

/** runtime.ts parseDetail + 海报 */
function buildDetail(provider: Provider, id: string, data: Record<string, unknown>, fallbackTitle: string, eps: Episode[], hint?: DetailHint): DetailView {
  const raw = isObj(data.raw) ? data.raw : {}
  const show = isObj(data.show) ? data.show : {}
  const category = asString(data.category) || asString(raw.category) || asString(show.category)
  const list = Array.isArray(data.episodes) ? data.episodes : []
  const kind = mediaKindFromMetadata(data) ?? hint?.mediaKind ?? 'show'
  return {
    provider,
    id,
    title: asString(data.title) || asString(raw.title) || asString(show.title) || fallbackTitle || hint?.title || '',
    poster: detailPoster(data) || hint?.poster || '',
    desc: (data.hasMore === true ? '目录分页未完整，仅显示已取得分集。' : '') + (asString(data.desc) || asString(raw.desc) || asString(data.intro) || asString(data.description)),
    category,
    year: anyInt(data.year) || anyInt(raw.year),
    tags: pickTags(data, raw),
    score: asString(data.score) || asString(raw.score),
    vip: data.is_vip === true || raw.is_vip === true,
    drm: isObj(data.drm) ? asString(data.drm.note) || asString(data.drm.drm_type) : '',
    kind,
    episodeCount: anyInt(data.episode_count) || anyInt(data.totalEps) || anyInt(raw.episode_count) || list.length || eps.length,
    episodes: eps.map(toEpisodeView),
    pickNoun: kind === 'movie' ? '个版本' : '集',
  }
}

function audioView(a: Audio): AudioView {
  return {
    id: a.id,
    label: a.label,
    lang: a.lang,
    codec: a.codec,
    isDefault: a.isDefault,
    selected: a.selected,
    embedded: !!a.embedded,
  }
}

/**
 * 多版本电影（英语版/国语版各一个 vid）探测时，每个 vid 都会带回全部语言的音轨，
 * 同一条音轨因此出现两次。按「语言 + 编码」去重：优先保留语言与所属版本一致的那条
 * （中文轨取国语版的 vid），没有就保留任一可用的。入队时 bindYoukuAudioTracksToTask
 * 还会按每集重新绑定，去重不影响批量下载。
 */
function dedupeAudios(audios: Audio[], vidLang: Map<string, string>): Audio[] {
  const best = new Map<string, Audio>()
  const order: string[] = []
  const langOf = (a: Audio) => youkuSpokenLangKey(a.lang) || a.lang
  for (const a of audios) {
    const key = `${langOf(a)}|${(a.codec || a.label).toLowerCase()}`
    const prev = best.get(key)
    if (!prev) {
      best.set(key, { ...a })
      order.push(key)
      continue
    }
    const matches = (x: Audio) => !!x.vid && vidLang.get(x.vid) === langOf(x)
    if (!matches(prev) && matches(a)) best.set(key, { ...a, isDefault: prev.isDefault || a.isDefault })
    else if (a.isDefault) prev.isDefault = true
  }
  return order.map((k) => best.get(k)!)
}

/** 隧道失败原因给人看：网关/WAF 的 403 回的是整页 HTML，原样显示只会是一串标签。 */
function tunnelErrText(err: string): string {
  if (!err) return ''
  if (/route forbidden|\b403\b/i.test(err)) return '服务未允许建立连接，请联系管理员检查使用权限。'
  if (/\b401\b|unauthori[sz]ed/i.test(err)) return '访问密钥无效或已过期，请在连接设置中检查。'
  return userMessage(err, '本机连接暂时不可用，请检查网络和代理设置。')
}

function mask(key: string): string {
  if (!key) return ''
  if (key.length <= 10) return '••••'
  return `${key.slice(0, 8)}••••••${key.slice(-4)}`
}

export class Core {
  private cfg: FileConfig = loadConfig()
  private readonly providerSessions = new ProviderSessions((p,a,input) => this.invoke(p,a,input))
  private readonly providerAccounts = new Map<string, ProviderSessionView>()
  private vaultMigrationReady = false
  private providerStartupChecked = false
  private iqStartupChecked = false
  private iqStatusCheck: 'idle' | 'checking' | 'checked' | 'failed' = 'idle'
  private connectionRevision = 0
  private cli: GwClient | null = null
  private keyInfo: KeyInfo | null = null
  private keyError = ''
  private connecting = false
  private tunnelOk = false
  private tunnelErr = ''
  private tunnelAbort: AbortController | null = null
  private ykLogin: YkLogin | null = null
  private ykAcct: YkAccount | null = null
  private ykSignMissing = false
  /** 瘦客户端：抖音 Cookie 托管在网关号池（启动探测结果）。 */
  private douyinReady = false
  private ykEnsure: Promise<void> | null = null
  private vipProbe: VipProbe | null = null
  private txAcct: TxAccount | null = null
  private tools: AppState['tools'] = []
  private readonly jobs = new Map<number, JobRecord>()
  private readonly hub: JobHub
  private probeToken = 0
  private readonly probes = new Map<number, { provider: Provider; qualities: Quality[]; audios: Audio[] }>()
  private qr: { kind: 'youku'; ticket: string; loginToken: string } | { kind: 'tencent'; done: { app: boolean; tv: boolean } } | { kind: 'iqcn' } | null = null

  constructor(private readonly emit: Emit) {
    this.hub = new JobHub((e) => this.onJob(e))
    this.loadJobs()
  }

  // ---------------------------------------------------------------- 生命周期

  async boot(): Promise<void> {
    void this.checkTools()
    try {
      setDesktopProxy(this.cfg.desktopProxy ?? '')
    } catch (error) {
      this.keyError = errText(error)
      this.emit.state()
      return
    }
    if (this.cfg.key.trim()) await this.connect()
    else this.emit.state()
  }

  /**
   * 退出前把在跑的任务停下来。
   * Windows 上 Electron 退出不会杀子进程（N_m3u8DL-RE / ffmpeg 会继续写文件），
   * 所以先等 cancelAll 把进程收掉（最多 3 秒），再把没停干净的任务标成已暂停。
   */
  async shutdown(): Promise<void> {
    this.tunnelAbort?.abort()
    try {
      await Promise.race([
        this.hub.cancelAll('pause'),
        new Promise<void>((r) => setTimeout(r, 3000)),
      ])
    } catch {
      /* 尽力而为 */
    }
    let dirty = false
    for (const rec of this.jobs.values()) {
      if (rec.view.state !== 'running' && rec.view.state !== 'queued') continue
      rec.view.state = 'paused'
      rec.view.status = '已暂停'
      rec.view.log = rec.view.log || '下次启动后点继续接着下'
      rec.view.busy = undefined
      dirty = true
    }
    if (dirty) {
      this.emit.jobs(this.jobList())
      this.flushJobs()
    }
  }

  // ---------------------------------------------------------------- 任务持久化

  private jobsPath(): string {
    return join(app.getPath('userData'), 'jobs.json')
  }

  /** 读 jobs.json：已完成的留着当历史，排队/进行中的一律变成「已暂停」等用户点继续。 */
  private loadJobs(): void {
    let data: JobsFile
    try {
      data = JSON.parse(readFileSync(this.jobsPath(), 'utf8')) as JobsFile
    } catch (e) {
      // 坏文件不该拦住启动，但得留个痕。
      runLog(`jobs load failed ${errText(e)}`)
      return
    }
    if (data.version !== JOBS_VERSION || !Array.isArray(data.jobs)) return
    let max = 0
    let changed = false
    for (const rec of data.jobs) {
      if (!isObj(rec) || !isObj(rec.view) || !isObj(rec.task) || !isObj(rec.pin)) continue
      const view = { ...rec.view } as JobView
      const id = anyInt(view.id)
      if (!id || this.jobs.has(id)) continue
      view.busy = undefined
      // Older IQ versions displayed the cropped height instead of the 4K tier.
      if (rec.task.provider === 'iq' && Number(rec.task.height) >= 2160 && /^\d+P\b/i.test(view.quality)) {
        view.quality = view.quality.replace(/^\d+P\b/i, '4K')
        changed = true
      }
      if (view.state === 'running' || view.state === 'queued') {
        view.state = 'paused'
        view.status = '已中断'
        view.log = '上次退出时未完成，点继续接着下'
        view.err = ''
        changed = true
      }
      this.jobs.set(id, { view, task: rec.task as DlTask, pin: rec.pin as Pin })
      if (id > max) max = id
    }
    // Only recover a source hint; download-time matching verifies the original VID.
    if (restoreIQCNSourceHints([...this.jobs.values()].sort((a, b) => a.view.id - b.view.id).map(rec => rec.task))) changed = true
    // 加载的任务不发 toast、不自动续跑（客户端可能都还没连上网关）。
    seedJobID(max)
    // 转换过的状态立刻落盘，免得文件里一直留着「运行中」误导后面的启动。
    if (changed) this.flushJobs()
  }

  private saveTimer: NodeJS.Timeout | null = null

  /** 状态变化立刻写，进度变化合并到 2 秒后写。 */
  private scheduleJobsSave(soon = false): void {
    if (soon) {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer)
        this.saveTimer = null
      }
      this.flushJobs()
      return
    }
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flushJobs()
    }, 2000)
  }

  /** 原子写：先写 .tmp 再 rename，半截文件不会把上次的任务列表弄丢。 */
  private flushJobs(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    const path = this.jobsPath()
    const out: JobsFile = {
      version: JOBS_VERSION,
      jobs: [...this.jobs.values()].map((r) => ({
        view: { ...r.view, busy: undefined },
        task: r.task,
        pin: r.pin,
      })),
    }
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, `${JSON.stringify(out)}\n`)
      renameSync(tmp, path)
    } catch (e) {
      runLog(`jobs save failed ${errText(e)}`)
    }
  }

  /** 退出时调用：把还在跑的 pushJobs 收掉，不再往回写文件。 */
  dispose(): void {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer)
      this.pushTimer = null
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  }

  private async checkTools(): Promise<void> {
    try {
      await ensureTools((s) => runLog(`tools ${s}`))
    } catch (e) {
      runLog(`tools missing ${errText(e)}`)
    }
    const probe = (name: string, look: () => string, note: string) => {
      let path = ''
      try {
        path = look()
      } catch {
        path = ''
      }
      const ok = !!path && existsSync(path)
      const miss = process.platform === 'darwin' ? 'brew install ffmpeg gpac mkvtoolnix' : '未找到'
      return { name, ok, note: ok ? note : miss }
    }
    this.tools = [
      probe('FFmpeg', lookBundledFFmpeg, process.platform === 'win32' ? '内置' : '已找到'),
      probe('N_m3u8DL-RE', lookM3u8dl, '内置 · 分片下载'),
      probe('mkvmerge', lookMkvmerge, '内置 · MKV 封装'),
      probe('MP4Box', lookMP4Box, '内置 · DTS 封装'),
    ]
    this.emit.state()
  }

  private async connect(): Promise<void> {
    const revision = ++this.connectionRevision
    this.vaultMigrationReady = false
    this.providerStartupChecked = false
    this.tunnelAbort?.abort()
    this.tunnelAbort = null
    this.tunnelOk = false
    this.tunnelErr = ''
    this.providerSessions.setScope(this.cfg.host + String.fromCharCode(0) + this.cfg.key)
    this.iqStartupChecked = false
    this.iqStatusCheck = 'idle'
    this.connecting = true
    this.keyError = ''
    this.emit.state()
    const cli = new GwClient(this.cfg.host, this.cfg.key, () => this.cfg, 'electron_process')
    this.cli = cli
    try {
      const info = await cli.keyInfo()
      if (revision !== this.connectionRevision) return
      this.keyInfo = info
    } catch (e) {
      if (revision !== this.connectionRevision) return
      this.keyInfo = null
      this.keyError = errText(e)
      this.connecting = false
      this.emit.state()
      throw e
    }
    await this.startTunnel(revision)
    if (revision !== this.connectionRevision) return
    this.emit.state()
    await this.migrateVaultOnce()
    if (revision !== this.connectionRevision) return
    this.vaultMigrationReady = true
    this.connecting = false
    this.probeProviderSessions()
    this.emit.state()
  }

  /** Only clear local credentials after the gateway confirms import on this connection. */
  private async migrateVaultOnce(): Promise<void> {
    const cli = this.cli
    const revision = this.connectionRevision
    if (!cli || !hasLocalCredentials(this.cfg)) return
    const snapshot = { ...this.cfg }
    const before = { ...snapshot }
    try {
      const result = await migrateLocalCredentials(cli, snapshot)
      if (revision !== this.connectionRevision || cli !== this.cli) return
      let changed = false
      for (const field of [...result.migrated, ...result.clearedDead]) {
        const key = field as 'tencentCookie' | 'youkuSign' | 'douyinCookie' | 'iqCookie'
        if (this.cfg[key] === before[key]) { this.cfg[key] = ''; changed = true }
      }
      if (changed) saveConfig(this.cfg)
    } catch (e) {
      runLog(`vault migrate skipped ${errText(e)}`)
    }
  }

  /** Probe saved gateway sessions once migration and the required tunnel are ready. */
  private probeProviderSessions(): void {
    if (!this.cli || !this.vaultMigrationReady || this.providerStartupChecked || (this.tunnelAbort && !this.tunnelOk)) return
    this.providerStartupChecked = true
    this.queueEnsureYouku()
    if (this.has('tencent')) void this.refreshTencent()
    if (this.has('douyin')) void this.probeDouyin()
    this.checkIQOnConnect()
    if (this.has('iqcn')) void this.providerSession({ provider: 'iqcn', op: 'status' }).catch(() => {})
    if (this.has('hamivideo')) void this.providerSession({ provider: 'hamivideo', op: 'status' }).catch(() => {})
  }

  private async probeDouyin(): Promise<void> {
    const revision = this.connectionRevision
    let ready = false
    try {
      const data = await this.invoke('douyin', 'login', { op: 'status' })
      ready = data.imported === true
    } catch { /* Retain an unknown/unset state when the query fails. */ }
    if (revision !== this.connectionRevision) return
    this.douyinReady = ready
    this.emit.state()
  }

  private checkIQOnConnect(): void {
    if (!this.vaultMigrationReady || !this.has('iq') || this.iqStartupChecked) return
    this.iqStartupChecked = true
    // The gateway owns the Web/TV credentials. Only read its saved session here.
    void this.providerSession({ provider: 'iq', op: 'status' }).catch(() => {})
  }

  private async startTunnel(revision: number): Promise<void> {
    this.tunnelAbort?.abort()
    this.tunnelAbort = null
    this.tunnelOk = false
    this.tunnelErr = ''
    if (!needsTunnel(p => this.has(p as Provider))) return
    // 开发调试：同一 Key 只能有一条隧道，别顶掉正在用的那一个
    if (process.env.GVS_NO_TUNNEL) return
    const proxy = await installTunnelWebSocket(this.cfg.host)
    if (revision !== this.connectionRevision) return
    const abort = new AbortController()
    this.tunnelAbort = abort
    runTunnel(
      this.cfg.host,
      this.cfg.key,
      (ok, err) => {
        if (abort.signal.aborted) return
        const was = this.tunnelOk
        this.tunnelOk = ok
        this.tunnelErr = ok ? '' : err
        if (ok) {
          this.probeProviderSessions()
          if (!was && this.vaultMigrationReady) this.queueEnsureYouku()
        }
        this.emit.state()
      },
      abort.signal,
      () => proxy,
    )
  }

  private has(p: string): boolean {
    if (!this.keyInfo) return false
    return this.keyInfo.all || this.keyInfo.scope.includes(p)
  }

  private providers(): Provider[] {
    return PROVIDERS.filter((p) => this.has(p))
  }

  private client(): GwClient {
    if (!this.cli) throw new Error('还没有连接网关')
    return this.cli
  }

  private async invoke(p: string, action: string, input: Record<string, unknown>, skipSign = false) {
    const cli = this.client()
    try {
      return await cli.invoke(p, action, input, cli.extra(this.cfg, p, skipSign))
    } catch (e) {
      // 网关只说「隧道未连接」，真正原因（比如 Key 没有隧道权限）在隧道状态里。
      const why = tunnelErrText(this.tunnelErr)
      if (why && /隧道未连接/.test(errText(e))) throw new Error(`${errText(e)}：${why}`)
      throw e
    }
  }

  // ---------------------------------------------------------------- 状态

  state(): AppState {
    return {
      accountScope: createHash('sha256').update(this.cfg.host + String.fromCharCode(0) + this.cfg.key).digest('hex'),
      configured: !!this.keyInfo,
      connecting: this.connecting,
      keyName: this.keyInfo?.name ?? '',
      keyError: this.keyError,
      providers: this.providers(),
      tunnel: { ok: this.tunnelOk, err: tunnelErrText(this.tunnelErr), enabled: !!this.tunnelAbort },
      accounts: this.accounts(),
      settings: this.settingsView(),
      tools: this.tools,
      version: app.getVersion(),
      platform: process.platform,
    }
  }

  private settingsView(): SettingsView {
    const c = this.cfg
    return {
      host: c.host,
      desktopProxy: c.desktopProxy ?? '',
      keyMasked: mask(c.key),
      hasKey: !!c.key,
      outDir: c.outDir,
      tmpDir: c.tmpDir ?? '',
      releaseGroup: c.releaseGroup,
      includeEpisodeTitle: c.includeEpisodeTitle !== false,
      tmdbKey: c.tmdbKey,
      tmdbLang: c.tmdbLang,
      threads: c.threads,
      tencentObservations: !!c.tencentObservations,
      hamiClient: c.hamiClient || 'tv',
      tencentCookie: c.tencentCookie,
      douyinCookie: c.douyinCookie ?? '',
      iqCookie: c.iqCookie ?? '',
      iqProfile: c.iqProfile ?? '',
      hongguoNfo: c.hongguoNfo,
      huangguoNfo: c.huangguoNfo,
      hongguoFmt: c.hongguoFmt,
      huangguoFmt: c.huangguoFmt,
    }
  }

  private accounts(): AccountView[] {
    return this.providers().map((p): AccountView => {
      if (p === 'youku') {
        if (!this.cfg.youkuSign && !this.ykLogin?.ok && !this.ykAcct)
          return { provider: p, short: '未登录', summary: '未登录 · 扫码后可下载会员片源', tone: 'warn' }
        if (this.ykSignMissing || this.ykAcct?.needsScan)
          return { provider: p, short: '需扫码', summary: '登录态失效 · 需要重新扫码', tone: 'warn' }
        if (!this.ykAcct) return { provider: p, short: '检查中', summary: '正在检查登录态…', tone: 'muted' }
        const vip = this.ykAcct.isVip || (this.vipProbe?.isVip ?? false)
        return {
          provider: p,
          short: vip ? '会员' : '已登录',
          summary: accountSummary(this.ykAcct, this.vipProbe ?? undefined),
          tone: 'ok',
        }
      }
      if (p === 'tencent') {
        if (this.txAcct?.loggedIn) return { provider: p, short: '已登录', summary: txAccountSummary(this.txAcct), tone: 'ok' }
        return { provider: p, short: '未登录', summary: '未登录 · 扫码或粘贴 Cookie', tone: 'warn' }
      }
      if (p === 'douyin') {
        return this.douyinReady
          ? { provider: p, short: '已托管', summary: 'Cookie 已托管网关号池（加密保存）', tone: 'ok' }
          : { provider: p, short: '未设置', summary: '搜索需要网页登录 Cookie（sessionid）', tone: 'warn' }
      }
      if (p === 'iq') {
        const account = this.providerAccounts.get('iq')
        if (this.iqStatusCheck === 'checking') return { provider:p, short:'检查中', summary:'正在检查网关保存的 IQ 会话…', tone:'muted' }
        if (this.iqStatusCheck === 'failed') return { provider:p, short:'待检查', summary:'暂时无法检查 IQ 会话，请在平台账号页重新查询状态', tone:'warn' }
        if (!account) return { provider:p, short:'待检查', summary:'等待连接后检查网关保存的 IQ 会话', tone:'muted' }
        const risk = account.state === 'risk_verification_required'
        const short = account.authenticated ? '已登录' : risk ? '需验证' : account.webAuthenticated ? 'Web 已登录' : '未登录'
        return { provider:p, short, summary:account.summary, tone:account.authenticated?'ok':'warn' }
      }
      if (p === 'iqcn') {
        const account = this.providerAccounts.get(p)
        return { provider:p, short:account?.authenticated?'已登录':'待登录', summary:account?.summary || '到平台账号设置扫码登录爱奇艺国内版', tone:account?.authenticated?'ok':'muted' }
      }
      if (isManifestProvider(p)) {
        const account = this.providerAccounts.get(p + (p === 'hamivideo' ? ':' + (this.cfg.hamiClient || 'tv') : ''))
        return { provider: p, short: account?.authenticated ? '已登录' : '待检查', summary: account?.summary || '网关保存独立账号会话；请到平台账号设置登录或检查', tone: account?.authenticated ? 'ok' : 'muted' }
      }
      return { provider: p, short: '免登录', summary: '无需登录', tone: 'muted' }
    })
  }

  // ---------------------------------------------------------------- 配置

  async setup(host: string, key: string, proxyAddress = this.cfg.desktopProxy ?? ''): Promise<AppState> {
    const h = host.trim().replace(/\/+$/, '')
    const k = key.trim() || this.cfg.key.trim()
    if (!/^https?:\/\//.test(h)) throw new Error('网关地址要以 http:// 或 https:// 开头')
    if (!k) throw new Error('请填写 API Key')
    const proxy = normalizeDesktopProxy(proxyAddress)
    const prev = { host: this.cfg.host, key: this.cfg.key, desktopProxy: this.cfg.desktopProxy, route: desktopProxy(), connected: !!this.keyInfo }
    this.providerAccounts.clear()
    this.cfg.host = h
    this.cfg.key = k
    this.cfg.desktopProxy = proxy
    setDesktopProxy(proxy)
    try {
      await this.connect()
    } catch (e) {
      this.cfg.host = prev.host
      this.cfg.key = prev.key
      this.cfg.desktopProxy = prev.desktopProxy
      setDesktopProxy(prev.route)
      this.connectionRevision++
      this.providerSessions.setScope(this.cfg.host + String.fromCharCode(0) + this.cfg.key)
      if (prev.connected) void this.connect().catch(() => {})
      else this.emit.state()
      throw new Error(`连接失败：${errText(e)}`)
    }
    saveConfig(this.cfg)
    this.queueEnsureYouku()
    return this.state()
  }

  async saveSettings(patch: SettingsPatch): Promise<AppState> {
    const c = this.cfg
    const proxy = patch.desktopProxy === undefined ? c.desktopProxy ?? '' : normalizeDesktopProxy(patch.desktopProxy)
    const reconnect =
      (patch.host !== undefined && patch.host.trim().replace(/\/+$/, '') !== c.host) ||
      (patch.key !== undefined && patch.key.trim() !== '' && patch.key.trim() !== c.key) ||
      proxy !== (c.desktopProxy ?? '')
    if (reconnect) return this.setup(patch.host ?? c.host, patch.key?.trim() || c.key, proxy)
    if (patch.outDir !== undefined) c.outDir = normalizeOutDir(patch.outDir) || c.outDir
    if (patch.tmpDir !== undefined) c.tmpDir = normalizeTmpDir(patch.tmpDir)
    if (patch.releaseGroup !== undefined) c.releaseGroup = patch.releaseGroup.trim()
    if (patch.includeEpisodeTitle !== undefined) c.includeEpisodeTitle = patch.includeEpisodeTitle === true
    if (patch.tmdbKey !== undefined) c.tmdbKey = patch.tmdbKey.trim()
    if (patch.tmdbLang !== undefined) c.tmdbLang = patch.tmdbLang.trim() || 'zh-CN'
    if (patch.threads !== undefined) c.threads = clampThreads(patch.threads)
    if (patch.tencentObservations !== undefined) c.tencentObservations = patch.tencentObservations === true
    if (patch.hamiClient !== undefined) { if (!['tv','web'].includes(patch.hamiClient)) throw new Error('无效 Hami 会话类型'); c.hamiClient = patch.hamiClient }
    if (patch.iqProfile !== undefined) c.iqProfile = patch.iqProfile.trim()
    // 瘦客户端：Cookie 粘贴即推给网关托管，tui.json 不再保存副本。
    const pushCred = async (kind: 'tencent' | 'douyin' | 'iq', value: string): Promise<void> => {
      const v = value.trim()
      if (!this.cli) throw new Error('网关未连接，凭证未保存')
      const client = this.cli
      try {
        await pushLocalCredential(client, kind, v)
        if (client !== this.cli || c !== this.cfg) throw new Error('网关连接已切换，请在当前连接重新导入凭证')
        if (kind === 'douyin') this.douyinReady = true
        runLog(`vault push ${kind} ok`)
      } catch (e) {
        runLog(`vault push ${kind} failed`)
        throw e
      }
    }
    // Await each import before clearing the corresponding legacy field or acknowledging success.
    if (patch.tencentCookie !== undefined) { await pushCred('tencent', patch.tencentCookie); c.tencentCookie = ''; saveConfig(c) }
    if (patch.douyinCookie !== undefined) { await pushCred('douyin', patch.douyinCookie); c.douyinCookie = ''; saveConfig(c) }
    if (patch.iqCookie !== undefined) { await pushCred('iq', patch.iqCookie); c.iqCookie = ''; saveConfig(c) }
    if (patch.hongguoNfo !== undefined) c.hongguoNfo = patch.hongguoNfo
    if (patch.huangguoNfo !== undefined) c.huangguoNfo = patch.huangguoNfo
    if (patch.hongguoFmt !== undefined) c.hongguoFmt = patch.hongguoFmt
    if (patch.huangguoFmt !== undefined) c.huangguoFmt = patch.huangguoFmt
    saveConfig(c)
    if (patch.tencentCookie !== undefined && this.has('tencent')) void this.refreshTencent()
    this.emit.state()
    return this.state()
  }

  // ---------------------------------------------------------------- 优酷登录态

  private queueEnsureYouku(): void {
    // 瘦客户端：无本地 yk_sign 也探测（网关按本 API key 解析绑定凭证）。
    if (!this.cli || this.ykEnsure || !this.has('youku')) return
    this.ykEnsure = this.ensureYouku().finally(() => {
      this.ykEnsure = null
    })
  }

  private async ensureYouku(): Promise<void> {
    const cli = this.client()
    const sign = this.cfg.youkuSign
    try {
      this.ykLogin = await ykLoginInfo(cli, sign)
    } catch {
      /* cred info 失败不影响后面 */
    }
    this.ykSignMissing = !this.ykLogin?.ok && SIGN_DEAD_RE.test(this.ykLogin?.hint ?? '')
    if (shouldRefreshYouku(this.ykLogin) && !this.ykSignMissing) {
      try {
        const res = await ykRefresh(cli, sign)
        if (res.refreshed) this.ykLogin = await ykLoginInfo(cli, sign)
      } catch (e) {
        runLog(`yk refresh failed ${errText(e)}`)
      }
    }
    try {
      this.ykAcct = await ykAccount(cli, sign)
      if (this.ykSignMissing) this.ykAcct.needsScan = true
    } catch (e) {
      runLog(`yk account failed ${errText(e)}`)
    }
    this.emit.state()
  }

  async youkuRenew(): Promise<string> {
    const cli = this.client()
    const res = await ykRefresh(cli, this.cfg.youkuSign)
    this.ykLogin = await ykLoginInfo(cli, this.cfg.youkuSign)
    await this.ensureYouku()
    if (res.needsRelogin) throw new Error(`需要重新扫码：${res.hint || '网关续期被拒'}`)
    return res.refreshed ? '优酷登录态已续期' : '登录态正常，无需续期'
  }

  private async renewSilently(): Promise<boolean> {
    if (!this.cfg.youkuSign || !this.cli) return false
    try {
      const res = await ykRefresh(this.cli, this.cfg.youkuSign)
      return !res.needsRelogin
    } catch {
      return false
    }
  }

  async youkuQrStart(): Promise<QRStart> {
    const data = await this.invoke('youku', 'login', { method: 'qr', force: '1' }, true)
    const ticket = asString(data.yk_ticket) || asString(data.ticket)
    const loginToken = asString(data.loginToken) || asString(data.login_token)
    const url = asString(data.qrCodeUrl) || asString(data.qr_url) || asString(data.url)
    if (!ticket && !loginToken) throw new Error('网关没有返回 yk_ticket')
    if (!url) throw new Error('网关没有返回二维码地址')
    this.qr = { kind: 'youku', ticket, loginToken }
    const image = await QRCode.toDataURL(url, { margin: 1, width: 420, errorCorrectionLevel: 'M' })
    return { images: [{ title: '优酷 App 扫码', image }], hint: '打开优酷 App，点右上角扫一扫' }
  }

  async youkuQrPoll(): Promise<QRPoll> {
    if (this.qr?.kind !== 'youku') return { done: false, message: '二维码已失效，请刷新', tone: 'warn' }
    const poll = await pollYoukuQR(this.client(), this.qr.ticket, this.qr.loginToken)
    if (poll.sign || poll.loggedIn) {
      this.cfg.youkuSign = ''
      saveConfig(this.cfg)
      // 瘦客户端：签名由网关按本 API key 绑定，不再写入 tui.json。
      this.qr = null
      this.ykSignMissing = false
      this.ykAcct = null
      this.emit.state()
      this.queueEnsureYouku()
      return { done: true, message: '优酷已登录', tone: 'ok' }
    }
    return { done: false, message: '等待扫码…', tone: 'muted' }
  }

  // ---------------------------------------------------------------- 腾讯

  private async refreshTencent(): Promise<void> {
    try {
      this.txAcct = await fetchTencentAccount(this.client())
    } catch (e) {
      runLog(`tencent account ${errText(e)}`)
    }
    this.emit.state()
  }

  async tencentQrStart(): Promise<QRStart> {
    const cli = this.client()
    const [appData, tvData] = await Promise.all([
      cli.invoke('tencent', 'login', { method: 'app', session_type: 'app', force: '1' }),
      cli.invoke('tencent', 'login', { method: 'tv', session_type: 'tv', force: '1', ...tencentTVLoginInput(this.cfg) }),
    ])
    const img = (d: Record<string, unknown>) => {
      const b64 = asString(d.qr_png_base64)
      if (!b64) throw new Error('网关没有返回二维码图片，请更新网关')
      return `data:image/png;base64,${b64}`
    }
    this.qr = { kind: 'tencent', done: { app: false, tv: false } }
    // 不用 startTencentDualQR：它会把 PNG 写盘并用系统看图打开，桌面端直接显示。
    return {
      images: [
        { title: '腾讯视频 App', image: img(appData) },
        { title: '云视听极光 TV', image: img(tvData) },
      ],
      hint: '两个码都要扫：先用腾讯视频 App 扫左边，再扫右边',
    }
  }

  async tencentQrPoll(): Promise<QRPoll> {
    if (this.qr?.kind !== 'tencent') return { done: false, message: '二维码已失效，请刷新', tone: 'warn' }
    const done = this.qr.done
    const data = await pollTencentDualQR(this.client())
    for (const side of ['app', 'tv'] as const) {
      const row = data[side]
      if (row.logged_in === true) done[side] = true
      if (row.status === 'expired' || row.status === 'cancelled')
        return { done: false, message: `${side === 'app' ? 'App' : 'TV'} 码已${row.status === 'expired' ? '过期' : '取消'}，请刷新`, tone: 'warn' }
    }
    if (done.app && done.tv) {
      applyTencentLogin(this.cfg, 'app', data.app)
      applyTencentLogin(this.cfg, 'tv', data.tv)
      this.cfg.tencentMode = 'tv'
      saveConfig(this.cfg)
      this.qr = null
      void this.refreshTencent()
      return { done: true, message: '腾讯 App 与 TV 均已登录', tone: 'ok' }
    }
    if (done.app || done.tv) return { done: false, message: `${done.app ? 'App' : 'TV'} 已登录，等待另一个码`, tone: 'muted' }
    return { done: false, message: '等待扫码…', tone: 'muted' }
  }

  async iqcnQrStart(): Promise<QRStart> {
    const view = await this.providerSession({ provider: 'iqcn', op: 'start' })
    if (!view.url) throw new Error('网关没有返回爱奇艺二维码')
    this.qr = { kind: 'iqcn' }
    const image = await QRCode.toDataURL(view.url, { margin: 1, width: 420, errorCorrectionLevel: 'M' })
    return { images: [{ title: '爱奇艺 App 扫码', image }], hint: view.summary }
  }

  async iqcnQrPoll(): Promise<QRPoll> {
    if (this.qr?.kind !== 'iqcn') return { done: false, message: '二维码已失效，请刷新', tone: 'warn' }
    const view = await this.providerSession({ provider: 'iqcn', op: 'poll' })
    if (view.authenticated) this.qr = null
    return { done: view.authenticated, message: view.summary, tone: view.authenticated ? 'ok' : ['expired', 'denied'].includes(view.state) ? 'warn' : 'muted' }
  }

  async qrCancel(): Promise<void> {
    if (this.qr?.kind === 'iqcn') await this.providerSession({ provider: 'iqcn', op: 'cancel' }).catch(() => undefined)
    this.qr = null
  }

  // ---------------------------------------------------------------- 浏览 / 搜索

  async tencentDiagnostics(jobID?: number) {
    if (!this.has('tencent')) throw new Error('当前 Key 没有腾讯权限')
    jobID = tencentDiagnosticJobID(jobID)
    if (jobID !== undefined && this.jobs.get(jobID)?.task.provider !== 'tencent') throw new Error('无效腾讯任务')
    return readTencentDiagnostics(this.cfg.host + String.fromCharCode(0) + this.cfg.key, jobID === undefined ? '' : String(jobID), 100)
  }

  async providerSession(command: SessionCommand): Promise<ProviderSessionView> {
    if (!this.has(command.provider)) throw new Error('当前 Key 没有该平台权限')
    const scope = this.cfg.host + String.fromCharCode(0) + this.cfg.key
    const revision = this.connectionRevision
    this.providerSessions.setScope(scope)
    const iqStatus = command.provider === 'iq' && command.op === 'status'
    if (iqStatus) { this.iqStatusCheck = 'checking'; this.emit.state() }
    let view: ProviderSessionView
    try {
      view = await this.providerSessions.command(command)
    } catch (e) {
      if (iqStatus && revision === this.connectionRevision && scope === this.cfg.host + String.fromCharCode(0) + this.cfg.key) { this.iqStatusCheck = 'failed'; this.emit.state() }
      throw e
    }
    if (revision !== this.connectionRevision || scope !== this.cfg.host + String.fromCharCode(0) + this.cfg.key) throw new Error('账号连接已切换')
    if (command.provider === 'iq') {
      this.iqStatusCheck = 'checked'
    }
    this.providerAccounts.set(command.provider + (command.provider === 'hamivideo' ? ':' + (command.op.startsWith('web_') ? 'web' : 'tv') : ''), view)
    this.emit.state()
    return view
  }

  async catalog(provider: Provider): Promise<Section[]> {
    if (!supportsBrowse(provider)) return [{ id: 'hami-link', title: '粘贴 Hami 产品链接', mode: 'link', available: false, reason: '当前网关仅支持产品链接/ID，尚无搜索或榜单接口' }]
    let sections: Array<Record<string, unknown>>
    try {
      const data = await this.invoke(provider, 'browse_catalog', {})
      if (!Array.isArray(data.sections)) throw new Error('INVALID_CATALOG')
      sections = data.sections.filter(isObj)
    } catch (e) {
      if (!['ACTION_UNSUPPORTED', 'PROVIDER_NOT_FOUND', 'NOT_FOUND'].includes(errorCode(e)) && !/unknown.*action|action.*browse_catalog|INVALID_CATALOG|not supported|not implemented|PROVIDER_NOT_FOUND|http 404/i.test(errText(e))) throw e
      sections = fallbackSections(provider)
    }
    return sections.map((s) => ({
      id: str(s.id),
      title: str(s.title),
      mode: str(s.mode),
      available: s.available !== false,
      reason: str(s.reason) || undefined,
    }))
  }

  async browse(provider: Provider, section: Section, cursor = ''): Promise<BrowseResult> {
    if (!section.available) return { cards: [], channels: [], more: false, next: '', notice: section.reason || '此栏目暂不可用' }
    const input: Record<string, unknown> = { mode: section.mode }
    if (section.id.startsWith('legacy-')) {
      if (provider === 'hongguo') input.sub = section.id.replace('legacy-', '')
    } else input.sectionId = section.id
    if (cursor) {
      input.cursor = cursor
      if (provider === 'hongguo') input.offset = cursor
    }
    const data = await this.invoke(provider, provider === 'mewatch' ? 'browse_section' : 'browse', { ...input })
    const cards = toCards(provider, { ...data, contentType: data.contentType || (section.mode === 'rank' ? 'rank' : '') })
    const next = str(data.nextCursor)
    const channels: Section[] = []
    for (const it of Array.isArray(data.items) ? data.items : []) {
      if (!isObj(it) || str(it.kind) !== 'channel') continue
      const t = isObj(it.target) ? it.target : {}
      const id = str(t.sectionId)
      const title = str(it.title)
      // 听书 / 小说 / 漫画 / 社区 不是视频，下载不了
      if (id && !/听书|小说|漫画|社区/.test(title)) channels.push({ id, title, mode: section.mode, available: true })
    }
    return { cards, channels, more: data.hasMore === true && !!next, next, notice: str(data.notice) }
  }

  parseLink(text: string): LinkTarget {
    const cnLink = extractIQCNLink(text)
    if (cnLink) return { kind: 'iqcn', url: cnLink }
    const iqLink = extractIQLink(text)
    if (iqLink) return { kind: 'iq', url: iqLink }
    const manifest = providerLink(text)
    if (manifest) return { kind: manifest.provider, url: manifest.url }
    const vid = extractYoukuVideoId(text)
    if (vid) return { kind: 'youku', vid }
    const tx = extractTencentLinks(text, 1)[0]
    if (tx && (tx.cid || tx.vid)) return { kind: 'tencent', cid: tx.cid, vid: tx.vid, url: tx.url }
    return { kind: 'none' }
  }

  searchTargets(): Provider[] {
    return this.providers().filter((p) => supportsSearch(p) && (p !== 'douyin' || !!this.cfg.douyinCookie))
  }

  /** 按平台单独搜：界面并发调用，先到先显示，不被最慢的平台拖住。 */
  async searchProvider(provider: Provider, query: string): Promise<SearchGroup> {
    if (!supportsSearch(provider)) return { provider, cards: [], error: '当前平台请粘贴产品链接打开详情' }
    const q = query.trim()
    try {
      const data = await this.invoke(provider, 'search', { q, pageSize: 20 })
      return { provider, cards: toCards(provider, data), error: '' }
    } catch (e) {
      return { provider, cards: [], error: errText(e) }
    }
  }

  // ---------------------------------------------------------------- 详情

  async detail(provider: Provider, id: string, hint?: DetailHint): Promise<DetailView> {
    const input: Record<string, unknown> = isManifestProvider(provider) && id.startsWith('https://') ? { url: id } : { id }
    if (provider === 'hongguo') input.seriesId = id
    else if (provider === 'youku') {
      input.showId = id
      input.all = '1'
      // 详情页只用到会员/DRM/语言版本；完整多档在进入画质页时的 play 里取。
      input.tier = 'single'
    } else if (provider === 'tencent') input.cid = id
    const data = isManifestProvider(provider) ? await manifestDetail((p,a,i) => this.invoke(p,a,i), provider, id) : await this.invoke(provider, 'detail', input)
    const eps = parseEps(data)
    // 有些老片/短剧详情接口不给海报和片名，卡片上其实已经有，拿它兜底。
    const view = buildDetail(provider, id, data, '', eps, hint)
    if (provider === 'iqcn') view.focusVid = asString(data.focusVid) || undefined
    await this.applyMovieEditions(view, data)
    return view
  }

  async detailFromLink(link: LinkTarget, hint?: DetailHint): Promise<DetailView> {
    if (link.kind === 'iqcn') return this.detail('iqcn', link.url, hint)
    if (link.kind === 'iq') return this.detail('iq', link.url, hint)
    if (link.kind === 'mewatch' || link.kind === 'hamivideo') return this.detail(link.kind, link.url, hint)
    if (link.kind === 'youku') {
      let data: Record<string, unknown> = {}
      try {
        data = await this.invoke('youku', 'detail', { vid: link.vid, proto: 'web' })
        if (isObj(data.show)) data = { ...data.show, ...data }
      } catch {
        /* 元数据可选：play 仍能按这个 vid 取流 */
      }
      const sid = asString(data.showId) || asString(isObj(data.show) ? data.show.showId : '')
      if (sid) {
        try {
          const view = await this.detail('youku', sid, hint)
          if (view.episodes.some(e => e.vid === link.vid)) {
            view.focusVid = link.vid
            return view
          }
        } catch {
          /* 回落到单视频 */
        }
      }
      if (!asString(data.title) && !hint?.title) {
        // 网页详情拿不到时，play 回包里也有片名
        try {
          const play = await this.invoke('youku', 'play', { vid: link.vid, tier: 'single', expand: '0' })
          data = { ...play, ...data, title: asString(play.title) || asString(isObj(play.video) ? play.video.title : '') }
        } catch {
          /* 留默认标题 */
        }
      }
      const title = asString(data.title) || hint?.title || `优酷视频 ${link.vid}`
      const one: Episode = parseEps(data).find((e) => e.vid === link.vid) ?? { vid: link.vid, title, number: 1, selected: true }
      return buildDetail('youku', link.vid, data, title, [one], hint)
    }
    if (link.kind === 'tencent') {
      if (link.cid) {
        const view = await this.detail('tencent', link.cid, hint)
        view.focusVid = link.vid || undefined
        return view
      }
      const data = await this.invoke('tencent', 'resolve', link.url ? { url: link.url } : { vid: link.vid })
      const cid = asString(data.cid)
      if (cid) return this.detail('tencent', cid, hint)
      const title = asString(data.title) || '腾讯视频'
      return buildDetail('tencent', link.vid, data, title, [{ vid: link.vid, title, number: 1, selected: true }], hint)
    }
    throw new Error('没认出链接：支持优酷播放页和腾讯视频播放页')
  }

  /** runtime.ts applyMovieEditions：电影按语言版本展开 */
  private async applyMovieEditions(view: DetailView, data: Record<string, unknown>): Promise<void> {
    if (view.kind !== 'movie' || isManifestProvider(view.provider)) return
    let play: Record<string, unknown> | undefined
    if (view.provider === 'youku' && !youkuEditionsFromDetail(data).length) {
      const vid = youkuMoviePick(data)?.vid || ''
      if (vid) {
        try {
          play = await this.invoke('youku', 'play', { vid, tier: 'single', expand: '0' })
        } catch {
          /* 正片来自详情 vid，不依赖这次 play */
        }
      }
    }
    const rows = moviePlayables(data, play)
    if (rows.length) {
      const dur = view.episodes[0]?.duration
      view.episodes = rows.map((e) => toEpisodeView({ ...e, duration: e.duration ?? (dur || undefined) }))
    } else if (view.episodes.length === 1) {
      view.episodes[0]!.title ||= '正片'
      view.episodes[0]!.group = 'edition'
    }
  }

  // ---------------------------------------------------------------- 画质探测

  async probe(provider: Provider, episodes: EpisodeView[]): Promise<ProbeResult> {
    const first = episodes[0]
    if (!first) throw new Error('先选至少一集')
    const seen = new Set<string>()
    const languages: Array<{ vid: string; lang: string }> = []
    for (const ep of episodes)
      for (const l of ep.languages) {
        if (!l.vid || seen.has(l.vid)) continue
        seen.add(l.vid)
        languages.push({ vid: l.vid, lang: l.lang })
      }
    const run = (skipSign: boolean) =>
      probeOptions(this.client(), this.cfg, provider, first.vid, {
        tencentPlayParams: first.tencentPlayParams,
        skipSign: skipSign || undefined,
        languages: languages.length ? languages : undefined,
      })
    let warning = ''
    let opts: Awaited<ReturnType<typeof probeOptions>>
    try {
      opts = await run(false)
    } catch (e) {
      if (!(e instanceof ReloginRequired) || !this.cfg.youkuSign) throw e
      // 与 TUI 一致：先让网关续期，再退回网关侧会话，都不改本机配置。
      if (await this.renewSilently()) opts = await run(false)
      else {
        opts = await run(true)
        warning = '本机优酷登录态不可用，这次用了网关侧会话；建议到设置里重新扫码'
      }
    }
    if (!opts.qualities.length) throw new Error('没有可用画质')
    if (provider === 'youku') {
      const vidLang = new Map<string, string>()
      for (const ep of episodes) for (const l of ep.languages) if (l.vid) vidLang.set(l.vid, youkuSpokenLangKey(l.lang, l.langcode))
      opts.audios = dedupeAudios(opts.audios, vidLang)
      for (const q of opts.qualities) if (q.audios?.length) q.audios = dedupeAudios(q.audios, vidLang)
    }
    if (opts.vip?.canPlay === false) throw new Error(opts.vip.note || '当前账号不能播放这部片')
    this.vipProbe = opts.vip ?? this.vipProbe
    const token = ++this.probeToken
    this.probes.set(token, { provider, qualities: opts.qualities, audios: opts.audios })
    if (this.probes.size > 20) this.probes.delete(Math.min(...this.probes.keys()))
    const qualities: QualityView[] = opts.qualities.map((q, index) => ({
      index,
      label: qualityChoiceLabel(q),
      title: q.title,
      stream: q.stream || q.id,
      width: q.width,
      height: q.height,
      size: q.size,
      codec: q.codec,
      drm: q.drm,
      hdr: q.hdr ?? '',
      fps: q.fps ?? 0,
      audios: (q.audios ?? []).map(audioView),
    }))
    this.emit.state()
    return {
      token,
      qualities,
      audios: opts.audios.map(audioView),
      vip: opts.vip ? { canPlay: opts.vip.canPlay, isVip: opts.vip.isVip, hasTrial: opts.vip.hasTrial, note: opts.vip.note } : null,
      warning,
    }
  }

  async tmdbSearch(title: string, tv: boolean): Promise<TmdbHit[]> {
    if (!this.cfg.tmdbKey.trim()) return []
    const hits = await tmdbSearch(this.cfg.tmdbKey, this.cfg.tmdbLang, title, { proxy: this.cfg.tmdbProxy })
    // Prefer the platform's type, but keep the other type: incomplete metadata
    // must not hide an exact movie match as if TMDB had no record.
    const preferred = tv ? 'show' : 'movie'
    return hits.sort((a, b) => Number(b.kind === preferred) - Number(a.kind === preferred))
      .map((h) => ({ id: h.id, name: h.name || h.title, title: h.title, year: h.year, overview: h.overview ?? '', kind: h.kind }))
  }

  async tmdbSeasons(id: number) {
    return tmdbSeasons(this.cfg.tmdbKey, this.cfg.tmdbLang, id, { proxy: this.cfg.tmdbProxy })
  }

  // ---------------------------------------------------------------- 入队

  /** runtime.ts taskFromEp + applyOptions + TMDB 选中 */
  private buildTasks(req: EnqueueRequest): { tasks: DlTask[]; qualityLabel: string } {
    const probe = this.probes.get(req.token)
    if (!probe) throw new Error('画质信息已过期，请重新打开画质页')
    const q = probe.qualities[req.quality]
    if (!q) throw new Error('请选择画质')
    const movie = (req.tmdb?.kind ?? req.detail.kind) === 'movie'
    const season = tmdbSeasonOverride(req.tmdbSeason, req.tmdb)
    // 与 TUI 一致：这一档自带音轨就用它的，否则用探测到的整体音轨（优酷各档都不单独带）
    const pool = q.audios?.length ? q.audios : probe.audios
    const tracks = selectAudioTracks(pool, req.audioIds, req.defaultAudioId)
      .map((a) => ({ id: a.id, label: a.label, lang: a.lang, vid: a.vid, codec: a.codec, isDefault: a.isDefault }))
    const tasks = req.episodes.map((ep, i): DlTask => {
      const t: DlTask = {
        provider: req.detail.provider,
        namingVersion: ['youku', 'tencent', 'iq', 'iqcn'].includes(req.detail.provider) ? 1 : undefined,
        includeEpisodeTitle: this.cfg.includeEpisodeTitle !== false,
        title: ep.title,
        series: movie ? req.detail.title : parseSeriesTitle(req.detail.title).title,
        vid: ep.vid,
        tencentPlayParams: ep.tencentPlayParams,
        season: movie ? 0 : season ?? seriesSeason(ep.season, req.detail.title),
        episode: movie ? 0 : ep.number || i + 1,
        collection: ep.collection,
        duration: ep.duration,
        height: 0,
        quality: q.stream || q.id,
        caption: q.caption,
        tencentQuality: req.detail.provider === 'tencent' ? selectedTencentQuality(q) : undefined,
        iqcnQuality: req.detail.provider === 'iqcn' ? selectedIQCNQuality(q, req.episodes[0]!.vid) : undefined,
        group: this.cfg.releaseGroup,
        codec: q.codec || '',
        tmdbId: 0,
        nameDots: '',
        year: req.detail.year,
        plot: '',
        kind: movie ? 'movie' : 'show',
        edition: movie ? movieEdition(ep.title, req.detail.title) : '',
        languages: ep.languages.filter((l) => l.vid).map((l) => ({ vid: l.vid, lang: l.lang })),
      }
      if (q.height > 0)
        t.height =
          q.tier ||
          ((t.provider === 'hongguo' || t.provider === 'huangguo') && q.width > 0 && q.height > q.width
            ? tierHeight(q.height, q.width)
            : tierHeight(q.width, q.height))
      t.audioTracks = t.provider === 'youku' ? bindYoukuAudioTracksToTask(tracks, t) : tracks.map((a) => ({ ...a }))
      if (req.tmdb) {
        t.tmdbId = req.tmdb.id
        t.year = req.tmdb.year || t.year
        t.nameDots = dots(req.tmdb.name)
        t.plot = req.tmdb.overview
        if (req.tmdb.name) t.series = req.tmdb.name
      }
      return t
    })
    return { tasks, qualityLabel: qualityChoiceLabel(q) }
  }

  namingPreview(req: EnqueueRequest): NamingPreview {
    const { tasks } = this.buildTasks(req)
    const t = tasks[0]
    if (!t) return { folder: '', file: '' }
    const n = jobNaming(t, this.cfg)
    return { folder: folder(n, this.cfg.outDir), file: usesMeasuredNaming(t)
      ? completedFilename(n, { status: 'unavailable', height: t.height, codec: t.codec }) : filename(n),
      ...(usesMeasuredNaming(t) ? { note: '封装后按实际规格、默认音轨及已确认档位补全文件名。' } : {}) }
  }

  enqueue(req: EnqueueRequest): number {
    const cli = this.client()
    const { tasks, qualityLabel } = this.buildTasks(req)
    const groupId = `${req.detail.provider}:${req.detail.id}:${Date.now()}`
    const pin = pinOf(this.cfg)
    const now = Date.now()
    for (const t of tasks) {
      const id = nextJobID()
      const movie = t.kind === 'movie'
      const label = movie ? t.edition || '正片' : `S${String(t.season).padStart(2, '0')}E${String(t.episode).padStart(2, '0')}`
      this.jobs.set(id, {
        task: t,
        pin,
        view: {
          id,
          groupId,
          groupTitle: req.detail.title,
          provider: req.detail.provider,
          poster: req.detail.poster,
          label,
          quality: qualityLabel,
          status: '排队中',
          pct: 0,
          log: '',
          err: '',
          note: '',
          state: 'queued',
          output: '',
          createdAt: now,
          finishedAt: 0,
        },
      })
      this.hub.enqueue(runCfg(this.cfg, pin), cli, id, t)
    }
    this.pushJobs()
    this.persist(true)
    return tasks.length
  }

  private onJob(e: JobEvt): void {
    const rec = this.jobs.get(e.id)
    if (!rec) return
    const v = rec.view
    // 暂停/取消的收尾事件只带状态，不要把进度和日志清掉。
    if (!e.done) {
      v.actualVersion = undefined
      v.completedMedia = undefined
      v.status = e.status
      v.pct = e.pct
      v.log = e.log
      v.err = e.err
      v.state = 'running'
    } else if (e.stopped === 'pause') {
      v.status = '已暂停'
      v.state = 'paused'
      if (e.log) v.log = e.log
      v.err = ''
      if (!v.pct) v.pct = e.pct
    } else if (e.stopped === 'cancel') {
      // removeJob 会把它从列表里删掉，这里不用管。
      return
    } else {
      v.status = e.status
      v.pct = e.pct
      v.log = e.log
      v.err = e.err
      v.note = e.note ?? ''
      v.state = e.err ? 'failed' : 'done'
      v.finishedAt = Date.now()
      if (!e.err) {
        v.output = e.log
        v.actualVersion = e.actualVersion
        v.completedMedia = e.completedMedia
      }
      if (!e.err) this.emit.toast(`${v.groupTitle} ${v.label} 下载完成${v.note ? `：${v.note}` : ''}`, v.note ? 'warn' : 'ok')
    }
    this.pushJobs()
    // 进度可以合并，状态变化要立刻落盘。
    this.persist(e.done === true)
  }

  /** 任务自己的配置 = 当前设置 + 入队时钉住的那些，保证续传路径/分片布局不变。 */
  private runCfg(rec: JobRecord): FileConfig {
    return runCfg(this.cfg, rec.pin)
  }

  private persist(soon: boolean): void {
    this.scheduleJobsSave(soon)
  }

  private pushTimer: NodeJS.Timeout | null = null
  private pushJobs(): void {
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.emit.jobs(this.jobList())
    }, 120)
  }

  jobList(): JobView[] {
    return [...this.jobs.values()].map((r) => ({ ...r.view }))
  }

  /** 排队中的任务没有进程，直接挂起；在跑的让 hub 停进程（保留已下载的分片）。 */
  async pauseJob(id: number): Promise<void> {
    const rec = this.jobs.get(id)
    if (!rec) return
    if (rec.view.state === 'paused' || rec.view.state === 'done' || rec.view.state === 'failed') return
    rec.view.busy = true
    this.pushJobs()
    try {
      // 排队中的任务也交给 hub 摘掉：它可能已经排在队列里，光改状态会被泵起来接着跑。
      // 排队中的是静默移除，正在跑的发 stopped:'pause' 并保留分片。
      await this.hub.cancel(id, 'pause')
    } finally {
      const cur = this.jobs.get(id)
      if (cur) {
        cur.view.busy = undefined
        // 停的那一刻刚好跑完/失败了，就按真实结果显示，别盖成「已暂停」。
        if (cur.view.state === 'running' || cur.view.state === 'queued') {
          cur.view.state = 'paused'
          cur.view.status = '已暂停'
          cur.view.err = ''
        }
        this.pushJobs()
        this.persist(true)
      }
    }
  }

  /** 继续：保留进度重新排队，runner 会从已有分片接着下。 */
  async resumeJob(id: number): Promise<void> {
    const rec = this.jobs.get(id)
    if (!rec || rec.view.busy) return
    if (rec.view.state !== 'paused' && rec.view.state !== 'failed') return
    // 没有网关连接就不排：不然状态会变成「排队中」然后再也没有下文。
    const cli = this.client()
    rec.view.busy = true
    rec.view.state = 'queued'
    rec.view.status = '排队中'
    rec.view.err = ''
    rec.view.log = ''
    this.pushJobs()
    this.persist(true)
    try {
      this.hub.enqueue(this.runCfg(rec), cli, id, rec.task)
    } catch (e) {
      rec.view.state = 'paused'
      rec.view.status = '已暂停'
      this.persist(true)
      throw e
    } finally {
      const cur = this.jobs.get(id)
      if (cur) {
        cur.view.busy = undefined
        this.pushJobs()
      }
    }
  }

  /** 从列表删除；在跑的先取消。deleteFiles 连成品和分片目录一起删。 */
  async removeJob(id: number, deleteFiles = false): Promise<void> {
    const rec = this.jobs.get(id)
    if (!rec) return
    // 以 hub 为准：状态是 paused 但进程还没收干净时（退出超时）也要能取消。
    if (this.hub.isActive(id)) {
      rec.view.busy = true
      this.pushJobs()
      try {
        await this.hub.cancel(id, 'cancel')
      } catch (e) {
        runLog(`cancel ${id} failed ${errText(e)}`)
      }
    }
    const cfg = this.runCfg(rec)
    // 只从列表移除时文件一律不动；勾了「同时删除」才删成品和工作目录。
    if (deleteFiles) {
      try {
        if (rec.view.state === 'done' && rec.view.output) {
          rmSync(rec.view.output, { force: true })
          rmSync(`${rec.view.output}.gvs.json`, { force: true })
        }
      } catch (e) {
        runLog(`remove output ${id} failed ${errText(e)}`)
      }
      try {
        await discardJobWork(cfg, rec.task)
      } catch (e) {
        runLog(`discard work ${id} failed ${errText(e)}`)
      }
    }
    this.jobs.delete(id)
    this.pushJobs()
    this.persist(true)
  }

  async pauseAll(): Promise<void> {
    const ids = [...this.jobs.values()].filter((r) => r.view.state === 'running' || r.view.state === 'queued').map((r) => r.view.id)
    for (const id of ids) await this.pauseJob(id)
  }

  async resumeAll(): Promise<void> {
    const ids = [...this.jobs.values()].filter((r) => r.view.state === 'paused' || r.view.state === 'failed').map((r) => r.view.id)
    for (const id of ids) await this.resumeJob(id)
  }

  retryJob(id: number): void {
    const rec = this.jobs.get(id)
    if (!rec || rec.view.state !== 'failed') return
    const cli = this.client() // 没有连接时保持 failed，别把按钮按成「排队中」
    Object.assign(rec.view, { status: '排队中', pct: 0, log: '', err: '', note: '', state: 'queued' })
    this.hub.enqueue(this.runCfg(rec), cli, id, rec.task)
    this.pushJobs()
    this.persist(true)
  }

  clearFinished(): void {
    for (const [id, r] of this.jobs) if (r.view.state === 'done') this.jobs.delete(id)
    this.pushJobs()
    this.persist(true)
  }

  // ---------------------------------------------------------------- 缓存 / 目录

  /**
   * 还在排队/正在跑/暂停/失败的任务，它的工作目录将来还会被用到（续传、重试要靠里面的分片），
   * 所以不算「残留」。已完成的任务 runner 自己会清目录。
   */
  private heldWorkDirs(): string[] {
    const dirs: string[] = []
    for (const rec of this.jobs.values()) {
      const s = rec.view.state
      // 失败的也算：重试会从这些分片接着下。
      if (s !== 'running' && s !== 'queued' && s !== 'paused' && s !== 'failed') continue
      try {
        dirs.push(jobWorkDir(this.runCfg(rec), rec.task))
      } catch {
        /* 配置缺字段时算不出来，跳过 */
      }
    }
    return dirs
  }

  /** 未被任何任务持有的临时目录项（残留）。 */
  private tempResidue(): string[] {
    const root = tmpRoot(this.cfg)
    const held = this.heldWorkDirs()
    const used = (p: string) => held.some((u) => p === u || p.startsWith(`${u}/`) || p.startsWith(`${u}\\`))
    let names: string[] = []
    try {
      names = readdirSync(root)
    } catch {
      return []
    }
    return names.map((n) => join(root, n)).filter((p) => !used(p))
  }

  cacheInfo(): { posters: number; temp: number } {
    const temp = this.tempResidue().reduce((n, p) => n + treeSize(p), 0)
    return { posters: posterCacheSize(), temp }
  }

  async clearCache(): Promise<void> {
    clearPosterCache()
    for (const p of this.tempResidue()) {
      try {
        rmSync(p, { recursive: true, force: true })
      } catch {
        /* 还被占着，下次再删 */
      }
    }
  }

  outDir(): string {
    return this.cfg.outDir
  }
}

/** 任务的运行配置：当前设置 + pin。key / cookie / sign 仍然来自当前设置。 */
function runCfg(cfg: FileConfig, pin: Pin): FileConfig {
  return { ...cfg, ...pin }
}
