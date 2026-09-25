// 桌面端业务核心：把 tui/src/lib 的能力编排成界面可调用的方法。
// 流程与 TUI runtime.ts 保持一致（探测 → 选画质/音轨 → TMDB → 入队），
// 只是去掉了按键状态机，改成显式参数。
import { app } from 'electron'
import { existsSync } from 'node:fs'
import QRCode from 'qrcode'
import { GwClient, ReloginRequired, type KeyInfo } from '@tui/client.ts'
import { clampThreads, loadConfig, normalizeOutDir, saveConfig, type FileConfig } from '@tui/config.ts'
import { fallbackSections } from '@tui/discovery.ts'
import { JobHub, bindYoukuAudioTracksToTask, nextJobID, type DlTask, type JobEvt } from '@tui/jobs.ts'
import { extractTencentLinks, extractYoukuVideoId } from '@tui/link.ts'
import { youkuSpokenLangKey } from '@tui/media.ts'
import { filename, folder, sourceTag, tierHeight, dots, type Naming } from '@tui/name.ts'
import { isDtsAudio } from '@tui/mp4box.ts'
import { moviePlayables, probeOptions, qualityChoiceLabel, youkuEditionsFromDetail, youkuMoviePick } from '@tui/quality.ts'
import { runLog } from '@tui/runlog.ts'
import { applyTencentLogin, pollTencentDualQR, tencentTVLoginInput } from '@tui/tencent-qr.ts'
import { fetchTencentAccount, txAccountSummary, type TxAccount } from '@tui/tencent-account.ts'
import { tmdbSearch } from '@tui/tmdb.ts'
import { ensureTools, lookBundledFFmpeg, lookMP4Box, lookMkvmerge, lookM3u8dl } from '@tui/tools.ts'
import { runTunnel } from '@tui/tunnel.ts'
import { anyInt, asString, firstStr, isObj } from '@tui/util.ts'
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

const SIGN_DEAD_RE = /not found|revoked|invalid Yk-Sign|yk_sign not found/i

type Emit = {
  state: () => void
  jobs: (jobs: JobView[]) => void
  toast: (message: string, tone: Tone) => void
}

type JobRecord = { view: JobView; task: DlTask }

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

function posterOf(...objs: Array<Record<string, unknown> | undefined>): string {
  for (const o of objs) {
    if (!o) continue
    const v = firstStr(o, 'poster', 'cover', 'img', 'pic', 'thumb', 'thumbnail', 'vThumbUrl', 'image', 'coverUrl', 'cover_url', 'horizontal_pic', 'vertical_pic')
    if (v && /^https?:\/\//.test(v)) return v
  }
  return ''
}

/** 网关 browse/search 条目 → 卡片（字段取法与 TUI discoveryRows / parseSearch 一致，多带海报）。 */
function toCards(provider: Provider, data: Record<string, unknown>): Card[] {
  const items = Array.isArray(data.items) ? data.items : Array.isArray(data.list) ? data.list : []
  const seen = new Set<string>()
  const out: Card[] = []
  for (const raw of items) {
    if (!isObj(raw)) continue
    const meta = isObj(raw.meta) ? raw.meta : {}
    const title = str(raw.title || raw.name || raw.seriesName || meta.title)
    let id = str(raw.seriesId || raw.showId || raw.cid || raw.id || raw.vid || meta.seriesId || meta.showId || meta.cid)
    if (id === '<nil>' || id === 'null') id = ''
    const kind = str(raw.kind || meta.kind)
    if (!title || /advert|广告|trailer|预告|channel/.test(kind)) continue
    const key = id && !id.includes('://') ? id : title
    if (seen.has(key)) continue
    seen.add(key)
    let target: Card['target'] = id && !id.includes('://') ? 'detail' : 'search'
    let reason = ''
    const t = isObj(raw.target) ? raw.target : isObj(meta.target) ? meta.target : null
    if (t && t.type === 'search') target = 'search'
    if (data.contentType === 'reservation' || kind === 'reservation' || kind === '预约') {
      target = 'unavailable'
      reason = '预约内容尚不可下载'
    }
    if (t && t.type === 'detail' && str(t.id)) id = str(t.id)
    const year = str(raw.year || meta.year)
    const eps = anyInt(raw.episodeCount ?? meta.episodeCount ?? raw.episode_count)
    const category = str(raw.category || meta.category)
    const metaBits = [category !== '首页' ? category : '', year, eps > 1 ? `${eps} 集` : ''].filter(Boolean)
    out.push({
      provider,
      id,
      title,
      poster: posterOf(raw, meta),
      desc: str(raw.subtitle || raw.desc || meta.subtitle || meta.subTitle || meta.desc || raw.feature),
      meta: metaBits.join(' · '),
      score: str(raw.score || meta.score),
      rank: data.contentType === 'rank' && Number(raw.rank) > 0 ? Number(raw.rank) : undefined,
      vip: raw.vip === true || raw.is_vip === true || meta.vip === true,
      target,
      reason,
    })
  }
  return out
}

function toEpisodeView(e: Episode): EpisodeView {
  return {
    vid: e.vid,
    title: e.title,
    number: e.number,
    group: e.group ?? '',
    duration: e.duration ?? 0,
    languages: e.languages ?? [],
  }
}

/** runtime.ts parseEps */
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
    const title = firstStr(it, 'title', 'name')
    const dur = anyInt(it.duration) || anyInt(it.duration_ms ? Number(it.duration_ms) / 1000 : 0)
    const extra = /周边|花絮|彩蛋|预告|预约|trailer|advert|extra|clip/i.test(`${kind} ${title}`) || it.is_trailer === true
    // 分组标错时，够长的节目仍然是正片。短须知、预告继续隐藏。
    if (extra && dur < 600) continue
    eps.push({
      title: firstStr(it, 'title', 'name'),
      vid: firstStr(it, 'vid', 'id'),
      number: n,
      selected: false,
      duration: anyInt(it.duration) || anyInt(it.duration_ms ? Number(it.duration_ms) / 1000 : 0) || undefined,
      group: firstStr(it, 'kind', 'group', 'stage'),
    })
  }
  return eps
}

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
function buildDetail(provider: Provider, id: string, data: Record<string, unknown>, fallbackTitle: string, eps: Episode[]): DetailView {
  const raw = isObj(data.raw) ? data.raw : {}
  const show = isObj(data.show) ? data.show : {}
  const category = asString(data.category) || asString(raw.category) || asString(show.category)
  const list = Array.isArray(data.episodes) ? data.episodes : []
  const kind: DetailView['kind'] = /电影/.test(category) ? 'movie' : 'show'
  return {
    provider,
    id,
    title: asString(data.title) || asString(raw.title) || asString(show.title) || fallbackTitle,
    poster: posterOf(data, raw, show),
    desc: asString(data.desc) || asString(raw.desc) || asString(data.intro) || asString(data.description),
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

function mask(key: string): string {
  if (!key) return ''
  if (key.length <= 10) return '••••'
  return `${key.slice(0, 8)}••••••${key.slice(-4)}`
}

export class Core {
  private cfg: FileConfig = loadConfig()
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
  private ykEnsure: Promise<void> | null = null
  private vipProbe: VipProbe | null = null
  private txAcct: TxAccount | null = null
  private tools: AppState['tools'] = []
  private readonly jobs = new Map<number, JobRecord>()
  private readonly hub: JobHub
  private probeToken = 0
  private readonly probes = new Map<number, { provider: Provider; qualities: Quality[]; audios: Audio[] }>()
  private qr: { kind: 'youku'; ticket: string; loginToken: string } | { kind: 'tencent'; done: { app: boolean; tv: boolean } } | null = null

  constructor(private readonly emit: Emit) {
    this.hub = new JobHub((e) => this.onJob(e))
  }

  // ---------------------------------------------------------------- 生命周期

  async boot(): Promise<void> {
    void this.checkTools()
    if (this.cfg.key.trim()) await this.connect()
    else this.emit.state()
  }

  shutdown(): void {
    this.tunnelAbort?.abort()
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
    this.connecting = true
    this.keyError = ''
    this.emit.state()
    this.cli = new GwClient(this.cfg.host, this.cfg.key, () => this.cfg)
    try {
      this.keyInfo = await this.cli.keyInfo()
    } catch (e) {
      this.keyInfo = null
      this.keyError = errText(e)
      this.connecting = false
      this.emit.state()
      throw e
    }
    this.connecting = false
    await this.startTunnel()
    this.emit.state()
    if (this.has('tencent')) void this.refreshTencent()
  }

  private async startTunnel(): Promise<void> {
    this.tunnelAbort?.abort()
    this.tunnelAbort = null
    this.tunnelOk = false
    this.tunnelErr = ''
    if (!this.has('youku') && !this.has('tencent')) return
    // 开发调试：同一 Key 只能有一条隧道，别顶掉正在用的那一个
    if (process.env.GVS_NO_TUNNEL) return
    await installTunnelWebSocket(this.cfg.host)
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
        if (ok && !was) this.queueEnsureYouku()
        this.emit.state()
      },
      abort.signal,
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

  private invoke(p: string, action: string, input: Record<string, unknown>, skipSign = false) {
    const cli = this.client()
    return cli.invoke(p, action, input, cli.extra(this.cfg, p, skipSign))
  }

  // ---------------------------------------------------------------- 状态

  state(): AppState {
    return {
      configured: !!this.keyInfo,
      connecting: this.connecting,
      keyName: this.keyInfo?.name ?? '',
      keyError: this.keyError,
      providers: this.providers(),
      tunnel: { ok: this.tunnelOk, err: this.tunnelErr, enabled: !!this.tunnelAbort },
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
      keyMasked: mask(c.key),
      hasKey: !!c.key,
      outDir: c.outDir,
      releaseGroup: c.releaseGroup,
      tmdbKey: c.tmdbKey,
      tmdbLang: c.tmdbLang,
      threads: c.threads,
      tencentCookie: c.tencentCookie,
      douyinCookie: c.douyinCookie ?? '',
      hongguoNfo: c.hongguoNfo,
      huangguoNfo: c.huangguoNfo,
      hongguoFmt: c.hongguoFmt,
      huangguoFmt: c.huangguoFmt,
    }
  }

  private accounts(): AccountView[] {
    return this.providers().map((p): AccountView => {
      if (p === 'youku') {
        if (!this.cfg.youkuSign) return { provider: p, short: '未登录', summary: '未登录 · 扫码后可下载会员片源', tone: 'warn' }
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
        if (this.cfg.tencentCookie) return { provider: p, short: 'Cookie', summary: 'Cookie 已设置', tone: 'ok' }
        return { provider: p, short: '未登录', summary: '未登录 · 扫码或粘贴 Cookie', tone: 'warn' }
      }
      if (p === 'douyin') {
        return this.cfg.douyinCookie
          ? { provider: p, short: 'Cookie', summary: 'Cookie 已设置', tone: 'ok' }
          : { provider: p, short: '未设置', summary: '搜索需要网页登录 Cookie（sessionid）', tone: 'warn' }
      }
      return { provider: p, short: '免登录', summary: '无需登录', tone: 'muted' }
    })
  }

  // ---------------------------------------------------------------- 配置

  async setup(host: string, key: string): Promise<AppState> {
    const h = host.trim().replace(/\/+$/, '')
    const k = key.trim()
    if (!/^https?:\/\//.test(h)) throw new Error('网关地址要以 http:// 或 https:// 开头')
    if (!k) throw new Error('请填写 API Key')
    const prev = { host: this.cfg.host, key: this.cfg.key }
    this.cfg.host = h
    this.cfg.key = k
    try {
      await this.connect()
    } catch (e) {
      this.cfg.host = prev.host
      this.cfg.key = prev.key
      throw new Error(`连接失败：${errText(e)}`)
    }
    saveConfig(this.cfg)
    this.queueEnsureYouku()
    return this.state()
  }

  async saveSettings(patch: SettingsPatch): Promise<AppState> {
    const c = this.cfg
    const reconnect =
      (patch.host !== undefined && patch.host.trim().replace(/\/+$/, '') !== c.host) ||
      (patch.key !== undefined && patch.key.trim() !== '' && patch.key.trim() !== c.key)
    if (reconnect) return this.setup(patch.host ?? c.host, patch.key?.trim() || c.key)
    if (patch.outDir !== undefined) c.outDir = normalizeOutDir(patch.outDir) || c.outDir
    if (patch.releaseGroup !== undefined) c.releaseGroup = patch.releaseGroup.trim()
    if (patch.tmdbKey !== undefined) c.tmdbKey = patch.tmdbKey.trim()
    if (patch.tmdbLang !== undefined) c.tmdbLang = patch.tmdbLang.trim() || 'zh-CN'
    if (patch.threads !== undefined) c.threads = clampThreads(patch.threads)
    if (patch.tencentCookie !== undefined) c.tencentCookie = patch.tencentCookie.trim()
    if (patch.douyinCookie !== undefined) c.douyinCookie = patch.douyinCookie.trim()
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
    if (!this.cli || !this.cfg.youkuSign || this.ykEnsure || !this.has('youku')) return
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
    if (!this.cfg.youkuSign) throw new Error('还没有登录优酷')
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
    if (poll.sign || (poll.loggedIn && this.cfg.youkuSign)) {
      if (poll.sign) this.cfg.youkuSign = poll.sign
      saveConfig(this.cfg)
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

  qrCancel(): void {
    this.qr = null
  }

  // ---------------------------------------------------------------- 浏览 / 搜索

  async catalog(provider: Provider): Promise<Section[]> {
    let sections: Array<Record<string, unknown>>
    try {
      const data = await this.invoke(provider, 'browse_catalog', {})
      if (!Array.isArray(data.sections)) throw new Error('INVALID_CATALOG')
      sections = data.sections.filter(isObj)
    } catch (e) {
      if (!/unknown.*action|action.*browse_catalog|INVALID_CATALOG|not supported|not implemented|PROVIDER_NOT_FOUND|http 404/i.test(errText(e))) throw e
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
    const data = await this.invoke(provider, 'browse', { ...input })
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
    const vid = extractYoukuVideoId(text)
    if (vid) return { kind: 'youku', vid }
    const tx = extractTencentLinks(text, 1)[0]
    if (tx && (tx.cid || tx.vid)) return { kind: 'tencent', cid: tx.cid, vid: tx.vid, url: tx.url }
    return { kind: 'none' }
  }

  searchTargets(): Provider[] {
    return this.providers().filter((p) => p !== 'douyin' || !!this.cfg.douyinCookie)
  }

  /** 按平台单独搜：界面并发调用，先到先显示，不被最慢的平台拖住。 */
  async searchProvider(provider: Provider, query: string): Promise<SearchGroup> {
    const q = query.trim()
    try {
      const data = await this.invoke(provider, 'search', { q, pageSize: 20 })
      return { provider, cards: toCards(provider, data), error: '' }
    } catch (e) {
      return { provider, cards: [], error: errText(e) }
    }
  }

  // ---------------------------------------------------------------- 详情

  async detail(provider: Provider, id: string): Promise<DetailView> {
    const input: Record<string, unknown> = { id }
    if (provider === 'hongguo') input.seriesId = id
    else if (provider === 'youku') {
      input.showId = id
      input.all = '1'
      // 详情页只用到会员/DRM/语言版本；完整多档在进入画质页时的 play 里取。
      input.tier = 'single'
    } else if (provider === 'tencent') input.cid = id
    const data = await this.invoke(provider, 'detail', input)
    const eps = parseEps(data)
    const view = buildDetail(provider, id, data, '', eps)
    await this.applyMovieEditions(view, data)
    return view
  }

  async detailFromLink(link: LinkTarget): Promise<DetailView> {
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
          return await this.detail('youku', sid)
        } catch {
          /* 回落到单视频 */
        }
      }
      if (!asString(data.title)) {
        // 网页详情拿不到时，play 回包里也有片名
        try {
          const play = await this.invoke('youku', 'play', { vid: link.vid, tier: 'single', expand: '0' })
          data = { ...play, ...data, title: asString(play.title) || asString(isObj(play.video) ? play.video.title : '') }
        } catch {
          /* 留默认标题 */
        }
      }
      const title = asString(data.title) || `优酷视频 ${link.vid}`
      const one: Episode = parseEps(data).find((e) => e.vid === link.vid) ?? { vid: link.vid, title, number: 1, selected: true }
      return buildDetail('youku', link.vid, data, title, [one])
    }
    if (link.kind === 'tencent') {
      if (link.cid) return this.detail('tencent', link.cid)
      const data = await this.invoke('tencent', 'resolve', link.url ? { url: link.url } : { vid: link.vid })
      const cid = asString(data.cid)
      if (cid) return this.detail('tencent', cid)
      const title = asString(data.title) || '腾讯视频'
      return buildDetail('tencent', link.vid, data, title, [{ vid: link.vid, title, number: 1, selected: true }])
    }
    throw new Error('没认出链接：支持优酷播放页和腾讯视频播放页')
  }

  /** runtime.ts applyMovieEditions：电影按语言版本展开 */
  private async applyMovieEditions(view: DetailView, data: Record<string, unknown>): Promise<void> {
    if (view.kind !== 'movie') return
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
    const hits = await tmdbSearch(this.cfg.tmdbKey, this.cfg.tmdbLang, title, tv)
    return hits.slice(0, 8).map((h) => ({ id: h.id, name: h.name || h.title, title: h.title, year: h.year, overview: h.overview ?? '' }))
  }

  // ---------------------------------------------------------------- 入队

  /** runtime.ts taskFromEp + applyOptions + TMDB 选中 */
  private buildTasks(req: EnqueueRequest): { tasks: DlTask[]; qualityLabel: string } {
    const probe = this.probes.get(req.token)
    if (!probe) throw new Error('画质信息已过期，请重新打开画质页')
    const q = probe.qualities[req.quality]
    if (!q) throw new Error('请选择画质')
    const movie = req.detail.kind === 'movie'
    // 与 TUI 一致：这一档自带音轨就用它的，否则用探测到的整体音轨（优酷各档都不单独带）
    const pool = q.audios?.length ? q.audios : probe.audios
    const pickedAudio = pool.filter((a) => req.audioIds.includes(a.id))
    const tracks = (pickedAudio.length ? pickedAudio : pool.filter((a) => a.isDefault).slice(0, 1))
      .filter((a) => !a.embedded)
      .map((a) => ({ id: a.id, label: a.label, lang: a.lang, vid: a.vid, codec: a.codec }))
    const tasks = req.episodes.map((ep, i): DlTask => {
      const t: DlTask = {
        provider: req.detail.provider,
        title: ep.title,
        series: req.detail.title,
        vid: ep.vid,
        season: movie ? 0 : 1,
        episode: movie ? 0 : ep.number || i + 1,
        height: 0,
        quality: q.stream || q.id,
        caption: q.caption,
        group: this.cfg.releaseGroup,
        codec: q.codec || '',
        tmdbId: 0,
        nameDots: '',
        year: req.detail.year,
        plot: '',
        kind: movie ? 'movie' : 'show',
        edition: movie && ep.title && ep.title !== '正片' ? ep.title : '',
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
        t.year = req.tmdb.year
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
    const n: Naming = {
      kind: t.kind ?? (t.provider === 'hongguo' || t.provider === 'huangguo' ? 'short' : 'show'),
      title: t.series || t.title,
      nameDots: t.nameDots,
      year: t.year,
      season: t.season,
      episode: t.episode,
      height: t.height,
      codec: t.codec || 'H264',
      edition: t.edition,
      source: sourceTag(t.provider),
      group: t.group.trim() || this.cfg.releaseGroup,
      tmdbId: t.tmdbId,
      // 与 jobs.ts runTask 一致：DTS 音轨走 MP4Box 输出 mp4
      container:
        t.provider === 'douyin' || (t.provider === 'youku' && t.audioTracks?.some(isDtsAudio))
          ? 'mp4'
          : t.provider === 'hongguo' && this.cfg.hongguoFmt
            ? this.cfg.hongguoFmt
            : t.provider === 'huangguo' && this.cfg.huangguoFmt
              ? this.cfg.huangguoFmt
              : 'mkv',
    }
    return { folder: folder(n, this.cfg.outDir), file: filename(n) }
  }

  enqueue(req: EnqueueRequest): number {
    const cli = this.client()
    const { tasks, qualityLabel } = this.buildTasks(req)
    const groupId = `${req.detail.provider}:${req.detail.id}:${Date.now()}`
    for (const t of tasks) {
      const id = nextJobID()
      const movie = t.kind === 'movie'
      const label = movie ? t.edition || '正片' : `S${String(t.season).padStart(2, '0')}E${String(t.episode).padStart(2, '0')}`
      this.jobs.set(id, {
        task: t,
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
        },
      })
      this.hub.enqueue({ ...this.cfg }, cli, id, t)
    }
    this.pushJobs()
    return tasks.length
  }

  private onJob(e: JobEvt): void {
    const rec = this.jobs.get(e.id)
    if (!rec) return
    const v = rec.view
    v.status = e.status
    v.pct = e.pct
    v.log = e.log
    v.err = e.err
    if (e.done) {
      v.note = e.note ?? ''
      v.state = e.err ? 'failed' : 'done'
      if (!e.err) v.output = e.log
      if (!e.err) this.emit.toast(`${v.groupTitle} ${v.label} 下载完成`, 'ok')
    } else v.state = 'running'
    this.pushJobs()
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

  retryJob(id: number): void {
    const rec = this.jobs.get(id)
    if (!rec || rec.view.state !== 'failed') return
    Object.assign(rec.view, { status: '排队中', pct: 0, log: '', err: '', note: '', state: 'queued' })
    this.hub.enqueue({ ...this.cfg }, this.client(), id, rec.task)
    this.pushJobs()
  }

  clearFinished(): void {
    for (const [id, r] of this.jobs) if (r.view.state === 'done') this.jobs.delete(id)
    this.pushJobs()
  }

  outDir(): string {
    return this.cfg.outDir
  }
}
