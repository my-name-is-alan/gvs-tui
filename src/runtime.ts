import { appendFileSync } from 'node:fs'
import { loadConfig, saveConfig, type FileConfig } from './lib/config.ts'
import { GwClient, type KeyInfo } from './lib/client.ts'
import { JobHub, jobTitle, nextJobID, patchJob, type DlTask } from './lib/jobs.ts'
import { probeOptions } from './lib/quality.ts'
import { runTunnel } from './lib/tunnel.ts'
import { hostIsLocal, importYoukuCookie, pollYoukuQR, startYoukuQR } from './lib/youku-qr.ts'
import { tmdbSearch } from './lib/tmdb.ts'
import { clipTitle, extractDouyinURL } from './lib/link.ts'
import { pickDouyinURL } from './lib/media.ts'
import { dots } from './lib/name.ts'
import { anyInt, asString, firstStr, isObj } from './lib/util.ts'
import type { Audio, Detail, Episode, Job, OptionTab, Quality, Row, Scene, Snapshot, StatusKind, TMDBHit } from './types.ts'

const ALL_PROVIDERS = ['youku', 'tencent', 'hongguo', 'douyin']

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
  private eps: Episode[] = []
  private qualities: Quality[] = []
  private audios: Audio[] = []
  private audioIdx = 0
  private optionTab: OptionTab = 'quality'
  private probeFailed = false
  private detailInfo: Detail | null = null
  private tmdbHits: TMDBHit[] = []
  private jobs: Job[] = []
  private pending: DlTask[] = []
  private detailTitle = ''
  private detailId = ''
  private detailProv = ''
  private qrAscii = ''
  private qrTicket = ''
  private tunnelOk = false
  private tunnelErr = ''
  private tunnelOn = false
  private readonly hub: JobHub
  private readonly listeners = new Set<Listener>()
  private readonly abort = new AbortController()
  private tunnelAbort: AbortController | null = null
  private qrTimer: NodeJS.Timeout | null = null

  constructor() {
    this.cfg = loadConfig()
    this.hostInput = this.cfg.host
    this.keyInput = this.cfg.key
    this.hub = new JobHub((e) => {
      patchJob(this.jobs, e)
      this.emit()
    })
    if (!this.cfg.key.trim()) {
      this.scene = 'setup'
    } else {
      this.cli = new GwClient(this.cfg.host, this.cfg.key)
      this.scene = 'home'
    }
    this.snapshot = this.build()
    if (this.scene === 'home') void this.refreshKey()
  }

  onSnapshot(fn: Listener): () => void {
    this.listeners.add(fn)
    fn(this.snapshot)
    return () => this.listeners.delete(fn)
  }

  set(field: string, value: string): void {
    if (field === 'query') this.query = value
    else if (field === 'host') {
      this.hostInput = value
      this.cfg.host = value.replace(/\/+$/, '').trim()
    } else if (field === 'key') this.keyInput = value
    else if (field === 'edit') this.editValue = value
    this.emit()
  }

  handleKey(name: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}): void {
    if (mods.ctrl && name.toLowerCase() === 'c') {
      this.close()
      return
    }
    const k = normKey(name, mods.shift)
    switch (this.scene) {
      case 'setup': this.updateSetup(k); break
      case 'home': this.updateHome(k); break
      case 'search': this.updateSearch(k); break
      case 'results': this.updateResults(k); break
      case 'detail': this.updateDetail(k); break
      case 'quality': this.updateQuality(k); break
      case 'tmdb': this.updateTMDB(k); break
      case 'jobs': if (k === 'esc') this.scene = 'home'; break
      case 'settings': this.updateSettings(k); break
      case 'qr': if (k === 'esc') { this.stopQR(); this.scene = 'settings' } break
      case 'edit': this.updateEdit(k); break
    }
    this.emit()
  }

  close(): void {
    this.stopQR()
    this.tunnelAbort?.abort()
    this.abort.abort()
  }

  private emit(): void {
    this.snapshot = this.build()
    for (const fn of this.listeners) fn(this.snapshot)
    trace(`emit scene=${this.scene} busy=${this.busy} tunnel=${this.tunnelOk} status=${this.status}`)
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
    this.busy = true
    this.emit()
    try {
      return await run()
    } finally {
      this.busy = false
      this.emit()
    }
  }

  private providers(): string[] {
    if (!this.keyInfo || !this.cli) return ALL_PROVIDERS
    const out = ALL_PROVIDERS.filter((p) => this.cli!.allows(this.keyInfo!.scope, this.keyInfo!.all, p))
    return out.length ? out : ALL_PROVIDERS
  }

  private has(p: string): boolean {
    if (!this.keyInfo || !this.cli) return true
    return this.cli.allows(this.keyInfo.scope, this.keyInfo.all, p)
  }

  private homeItems(): string[] {
    const items: string[] = []
    if (this.has('douyin')) items.push('粘贴链接')
    items.push('搜索')
    if (this.has('hongguo') || this.has('youku') || this.has('tencent')) items.push('榜单')
    items.push('任务', '设置')
    return items
  }

  private settingFields(): string[] {
    const f = ['隧道', '网关', 'Key', '下载目录']
    if (this.has('youku') || this.has('tencent') || this.has('hongguo')) f.push('发布组')
    if (this.has('youku') || this.has('tencent')) f.push('TMDB Key')
    if (this.has('youku')) f.push('优酷扫码', '优酷 Cookie', 'Yk-Sign')
    if (this.has('tencent')) f.push('腾讯 Cookie')
    if (this.has('hongguo')) f.push('红果合并', '红果 NFO', '红果封装')
    f.push('ffmpeg')
    return f
  }

  private settingValue(f: string): string {
    switch (f) {
      case '隧道':
        if (this.tunnelOk) return '已连接 · 优酷/腾讯走本机 IP'
        if (this.tunnelErr) return `断开  ${this.tunnelErr}`
        return '未连接'
      case '网关': return this.cfg.host
      case 'Key': return this.cfg.key.length > 12 ? `${this.cfg.key.slice(0, 12)}…` : this.cfg.key
      case '下载目录': return this.cfg.outDir
      case '发布组': return this.cfg.releaseGroup || '未设'
      case 'TMDB Key': return this.cfg.tmdbKey ? '已配置' : '未配置'
      case '优酷 Cookie': return '粘贴浏览器 Cookie（含 P_sck）'
      case 'Yk-Sign': return this.cfg.youkuSign ? '已登录' : '未登录'
      case '腾讯 Cookie': return this.cfg.tencentCookie ? '已保存' : '空 · 回车粘贴'
      case '红果合并': return this.cfg.hongguoMerge ? '开' : '关'
      case '红果 NFO': return this.cfg.hongguoNfo ? '开' : '关'
      case '红果封装': return this.cfg.hongguoFmt
      case 'ffmpeg': return this.cfg.ffmpeg
      default: return ''
    }
  }

  private editSeed(f: string): string {
    switch (f) {
      case '网关': return this.cfg.host
      case 'Key': return this.cfg.key
      case '下载目录': return this.cfg.outDir
      case '发布组': return this.cfg.releaseGroup
      case 'TMDB Key': return this.cfg.tmdbKey
      case '腾讯 Cookie': return this.cfg.tencentCookie
      case 'ffmpeg': return this.cfg.ffmpeg
      default: return ''
    }
  }

  private build(): Snapshot {
    const cursor = this.scene === 'quality' ? this.qIdx : this.scene === 'settings' ? this.setIdx : this.cursor
    return {
      scene: this.scene,
      host: this.cfg.host,
      status: this.status,
      statusKind: this.statusKind,
      busy: this.busy,
      tunnelOk: this.tunnelOk,
      tunnelError: this.tunnelErr || undefined,
      cursor,
      providerIndex: this.provIdx,
      qualityIndex: this.qIdx,
      audioIndex: this.audioIdx,
      optionTab: this.optionTab,
      providers: this.providers(),
      homeItems: this.homeItems(),
      rows: this.rows,
      episodes: this.eps,
      qualities: this.qualities,
      audios: this.audios,
      tmdbHits: this.tmdbHits,
      jobs: this.jobs,
      settings: this.settingFields().map((label) => ({ label, value: this.settingValue(label) })),
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
    }
  }

  private async refreshKey(): Promise<void> {
    if (!this.cli) return
    await this.work(async () => {
      try {
        this.keyInfo = await this.cli!.keyInfo()
        this.say(`${this.keyInfo.name}  scope=${this.keyInfo.all || !this.keyInfo.scope?.length ? '全部' : this.keyInfo.scope.join(',')}  ${
          this.keyInfo.permanent || !this.keyInfo.expiresAt ? '永不到期' : `剩 ${this.keyInfo.daysLeft ?? 0} 天`
        }`, 'ok')
        if (!this.tunnelOn && (this.has('youku') || this.has('tencent'))) {
          this.tunnelOn = true
          this.tunnelAbort = new AbortController()
          // A tunnel that is torn down and redialled every few seconds must not
          // own the status line: the header dot already shows the live state, so
          // only the first drop is announced, and recovery only after a real gap.
          let announcedDrop = false
          let downSince = 0
          runTunnel(this.cfg.host, this.cfg.key, (ok, err) => {
            this.tunnelOk = ok
            this.tunnelErr = err
            if (ok) {
              if (downSince && Date.now() - downSince > 8000) this.say('隧道已恢复：优酷/腾讯走本机 IP', 'ok')
              downSince = 0
            } else {
              downSince ||= Date.now()
              if (!announcedDrop) {
                announcedDrop = true
                this.say(
                  err === 'closed' ? '隧道断开，自动重连中（优酷/腾讯暂时走本机 IP）' : `隧道断开 ${err}`,
                  'warn',
                )
              }
            }
            this.emit()
          }, this.tunnelAbort.signal)
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
    saveConfig(this.cfg)
    this.cli = new GwClient(this.cfg.host, this.cfg.key)
    this.scene = 'home'
    void this.refreshKey()
  }

  private updateHome(k: string): void {
    const items = this.homeItems()
    if (k === 'j' || k === 'down') this.cursor = (this.cursor + 1) % items.length
    else if (k === 'k' || k === 'up') this.cursor = (this.cursor - 1 + items.length) % items.length
    else if (k === 'enter') {
      switch (items[this.cursor]) {
        case '粘贴链接': {
          this.scene = 'search'
          const i = this.providers().indexOf('douyin')
          if (i >= 0) this.provIdx = i
          this.say('把抖音分享口令或链接贴进来，回车直接下载')
          break
        }
        case '搜索': this.scene = 'search'; break
        case '榜单': void this.rank(); break
        case '任务': this.scene = 'jobs'; break
        case '设置': this.scene = 'settings'; this.setIdx = 0; break
      }
    }
  }

  private updateSearch(k: string): void {
    const ps = this.providers()
    if (k === 'esc') { this.scene = 'home'; return }
    if ((k === 'left' || k === 'h') && ps.length) this.provIdx = (this.provIdx - 1 + ps.length) % ps.length
    else if ((k === 'right' || k === 'l') && ps.length) this.provIdx = (this.provIdx + 1) % ps.length
    else if (k === 'enter') {
      const q = this.query.trim()
      if (!q) return
      const dy = extractDouyinURL(q)
      if (dy) {
        void this.downloadDouyin('', '', dy)
        return
      }
      void this.search(this.providers()[this.provIdx] ?? 'hongguo', q)
    }
  }

  private updateResults(k: string): void {
    if (!this.rows.length) {
      if (k === 'esc') this.scene = 'search'
      return
    }
    if (k === 'esc') this.scene = 'search'
    else if (k === 'j' || k === 'down') this.cursor = (this.cursor + 1) % this.rows.length
    else if (k === 'k' || k === 'up') this.cursor = (this.cursor - 1 + this.rows.length) % this.rows.length
    else if (k === 'enter') {
      const r = this.rows[this.cursor]
      if (r.sub === 'douyin') {
        void this.downloadDouyin(r.title, r.id, r.id ? `https://www.douyin.com/video/${r.id}` : '')
        return
      }
      this.detailProv = r.sub
      this.detailId = r.id
      void this.detail(r.sub, r.id)
    }
  }

  private updateDetail(k: string): void {
    const n = this.eps.length
    if (!n) {
      if (k === 'esc') this.scene = 'results'
      return
    }
    if (k === 'esc') { this.scene = 'results'; return }
    if (k === 'left' || k === 'h') this.cursor = (this.cursor - 1 + n) % n
    else if (k === 'right' || k === 'l') this.cursor = (this.cursor + 1) % n
    else if (k === 'j' || k === 'down') this.cursor = (this.cursor + 1) % n
    else if (k === 'k' || k === 'up') this.cursor = (this.cursor - 1 + n) % n
    else if (k === ' ' || k === 'space') this.eps[this.cursor].selected = !this.eps[this.cursor].selected
    else if (k === 'a') {
      for (const ep of this.eps) ep.selected = true
      this.say(`已选 ${n} 集`, 'ok')
    } else if (k === 'c') {
      for (const ep of this.eps) ep.selected = false
      this.say('已清空选择')
    } else if (k === 'enter' || k === 'd') {
      const tasks = this.selectedTasks()
      void this.queueEpisodes(tasks.length ? tasks : [this.taskFromEp(this.cursor)])
    } else if (k === 'A' || k === 'f') {
      void this.queueEpisodes(this.eps.map((_, i) => this.taskFromEp(i)))
    }
  }

  private updateQuality(k: string): void {
    const nq = this.qualities.length
    const na = this.audios.length
    const hasAudio = na > 0
    if (k === 'esc') { this.scene = 'detail'; return }
    if (hasAudio && (k === 'tab' || k === 'left' || k === 'right' || k === 'h' || k === 'l')) {
      this.optionTab = this.optionTab === 'quality' ? 'audio' : 'quality'
      return
    }
    const onAudio = hasAudio && this.optionTab === 'audio'
    const n = onAudio ? na : nq
    if (!n) return
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
  }

  /** Stamp the chosen quality (and audio track) onto every pending task. */
  private applyOptions(): void {
    const q = this.qualities[this.qIdx]
    const a = this.audios[this.audioIdx]
    for (const t of this.pending) {
      if (q) {
        t.quality = q.id
        t.group = this.cfg.releaseGroup
        if (q.height > 0) t.height = q.height
        if (q.codec) t.codec = q.codec
      }
      if (a) t.audio = a.id
    }
    this.probeFailed = false
    if (q) this.say(a ? `画质 ${q.label} · 音轨 ${a.label}` : `画质 ${q.label}`, 'ok')
  }

  private updateTMDB(k: string): void {
    if (k === 'esc') { void this.enqueueAll(this.pending); return }
    if (this.tmdbHits.length && (k === 'j' || k === 'down')) this.cursor = (this.cursor + 1) % this.tmdbHits.length
    else if (this.tmdbHits.length && (k === 'k' || k === 'up')) this.cursor = (this.cursor - 1 + this.tmdbHits.length) % this.tmdbHits.length
    else if (k === 'enter' && this.tmdbHits[this.cursor]) {
      const h = this.tmdbHits[this.cursor]
      for (const t of this.pending) {
        t.tmdbId = h.id
        t.year = h.year
        t.nameDots = dots(h.name)
        t.plot = h.overview ?? ''
        if (h.name) t.series = h.name
      }
      void this.enqueueAll(this.pending)
    }
  }

  private updateSettings(k: string): void {
    const fields = this.settingFields()
    if (k === 'esc') {
      this.scene = 'home'
      saveConfig(this.cfg)
      return
    }
    if (fields.length && (k === 'j' || k === 'down')) this.setIdx = (this.setIdx + 1) % fields.length
    else if (fields.length && (k === 'k' || k === 'up')) this.setIdx = (this.setIdx - 1 + fields.length) % fields.length
    else if (k === 'enter' || k === ' ' || k === 'space') {
      if (fields[this.setIdx]) void this.openSetting(fields[this.setIdx])
    }
  }

  private updateEdit(k: string): void {
    if (k === 'esc') { this.scene = 'settings'; return }
    if (k === 'enter') void this.commitEdit(this.editValue.trim())
  }

  private async openSetting(f: string): Promise<void> {
    if (f === '隧道') {
      this.say(this.tunnelOk ? '隧道已连接' : (this.tunnelErr || '未连接'), this.tunnelOk ? 'ok' : 'warn')
      this.emit()
      return
    }
    if (f === '优酷扫码') {
      if (!this.cli) return
      this.say(hostIsLocal(this.cfg.host) ? '本机网关，扫码从家庭 IP 出去。' : '扫码从本机 IP 出网（隧道）。')
      try {
        const qr = await startYoukuQR(this.cli)
        this.qrTicket = qr.ticket
        this.qrAscii = qr.ascii
        this.scene = 'qr'
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
    if (f === '红果合并') { this.cfg.hongguoMerge = !this.cfg.hongguoMerge; saveConfig(this.cfg); this.emit(); return }
    if (f === '红果 NFO') { this.cfg.hongguoNfo = !this.cfg.hongguoNfo; saveConfig(this.cfg); this.emit(); return }
    if (f === '红果封装') {
      this.cfg.hongguoFmt = this.cfg.hongguoFmt === 'mp4' ? 'mkv' : 'mp4'
      saveConfig(this.cfg)
      this.emit()
      return
    }
    this.editField = f
    this.editValue = this.editSeed(f)
    this.scene = 'edit'
    this.emit()
  }

  private async commitEdit(v: string): Promise<void> {
    switch (this.editField) {
      case '网关':
        this.cfg.host = v.replace(/\/+$/, '')
        if (this.cfg.key) this.cli = new GwClient(this.cfg.host, this.cfg.key)
        break
      case 'Key':
        this.cfg.key = v
        this.cli = new GwClient(this.cfg.host, this.cfg.key)
        saveConfig(this.cfg)
        this.scene = 'settings'
        await this.refreshKey()
        return
      case '下载目录': this.cfg.outDir = v; break
      case '发布组': this.cfg.releaseGroup = v; break
      case 'TMDB Key': this.cfg.tmdbKey = v; break
      case '腾讯 Cookie': this.cfg.tencentCookie = v; break
      case 'ffmpeg': this.cfg.ffmpeg = v; break
      case '优酷 Cookie':
        if (!v) { this.say('Cookie 为空', 'warn'); this.scene = 'settings'; this.emit(); return }
        if (!this.cli) return
        this.scene = 'settings'
        this.say('正在导入优酷 Cookie…')
        this.emit()
        try {
          this.cfg.youkuSign = await this.work(() => importYoukuCookie(this.cli!, v))
          saveConfig(this.cfg)
          this.say('优酷 Cookie 已导入', 'ok')
        } catch (e) {
          this.say(`Cookie 导入失败：${e instanceof Error ? e.message : e}`, 'err')
        }
        this.emit()
        return
    }
    saveConfig(this.cfg)
    this.say(`${this.editField} 已保存`, 'ok')
    this.scene = 'settings'
    this.emit()
  }

  private taskFromEp(i: number): DlTask {
    const ep = this.eps[i]
    return {
      provider: this.detailProv,
      title: ep.title,
      series: this.detailTitle,
      vid: ep.vid,
      season: 1,
      episode: ep.number || i + 1,
      height: 0,
      quality: '',
      group: this.cfg.releaseGroup,
      codec: '',
      tmdbId: 0,
      nameDots: '',
      year: 0,
      plot: '',
    }
  }

  private selectedTasks(): DlTask[] {
    return this.eps.flatMap((ep, i) => (ep.selected ? [this.taskFromEp(i)] : []))
  }

  private async queueEpisodes(tasks: DlTask[]): Promise<void> {
    if (!tasks.length || !this.cli) return
    if (this.detailProv === 'douyin') {
      for (const t of tasks) t.url = t.vid ? `https://www.douyin.com/video/${t.vid}` : t.url
      this.enqueueAll(tasks)
      return
    }
    this.pending = tasks
    // The user just asked for these episodes; if the stream list fails we stop
    // here and say so, instead of quietly downloading a guessed quality. A
    // second Enter (probeFailed) goes ahead with the platform default.
    if (this.probeFailed) {
      this.say('用默认画质下载（跳过画质选择）', 'warn')
      await this.afterQuality()
      return
    }
    this.say('正在取画质…')
    this.emit()
    try {
      const opts = await this.work(() => probeOptions(this.cli!, this.cfg, this.detailProv, tasks[0].vid))
      this.qualities = opts.qualities
      this.audios = opts.audios
      this.qIdx = 0
      this.audioIdx = Math.max(0, opts.audios.findIndex((a) => a.isDefault))
      this.optionTab = 'quality'
      this.probeFailed = false
      this.scene = 'quality'
      this.say(`${opts.qualities.length} 档画质${opts.audios.length ? ` · ${opts.audios.length} 条音轨` : ''} · ${tasks.length} 集`, 'ok')
    } catch (e) {
      this.probeFailed = true
      this.qualities = []
      this.audios = []
      this.say(`取画质失败：${e instanceof Error ? e.message : e} · 再按 ⏎ 用默认画质下载`, 'err')
    }
    this.emit()
  }

  private async afterQuality(): Promise<void> {
    const tasks = this.pending
    if ((this.detailProv === 'youku' || this.detailProv === 'tencent') && this.cfg.tmdbKey.trim()) {
      try {
        const hits = await tmdbSearch(this.cfg.tmdbKey, this.cfg.tmdbLang, this.detailTitle, true)
        if (hits.length) {
          this.tmdbHits = hits.map((h) => ({ id: h.id, name: h.name || h.title, title: h.title, year: h.year, overview: h.overview }))
          this.cursor = 0
          this.scene = 'tmdb'
          this.emit()
          return
        }
      } catch (e) {
        this.say(`TMDB: ${e instanceof Error ? e.message : e}`, 'warn')
      }
    }
    this.enqueueAll(tasks)
  }

  private enqueueAll(tasks: DlTask[]): void {
    if (!this.cli || !tasks.length) return
    for (const t of tasks) {
      const id = nextJobID()
      this.jobs.push({ id, title: jobTitle(t), status: '排队', pct: 0, log: '', err: '' })
      this.hub.enqueue(this.cfg, this.cli, id, t)
    }
    this.pending = []
    this.scene = 'jobs'
    this.say(`已加入 ${tasks.length} 个任务`, 'ok')
    this.emit()
  }


  private async downloadDouyin(title: string, vid: string, url: string): Promise<void> {
    if (!this.cli) return
    if (!this.has('douyin')) {
      this.say('当前 Key 没有抖音权限', 'err')
      this.emit()
      return
    }
    const link = url.trim() || (vid ? `https://www.douyin.com/video/${vid}` : '')
    if (!link) {
      this.say('没有抖音链接', 'err')
      this.emit()
      return
    }
    this.say('正在解析抖音链接…')
    this.emit()
    try {
      const data = await this.work(() => this.cli!.invoke('douyin', 'resolve', { url: link }))
      if (!pickDouyinURL(data)) throw new Error('这条没有视频直链（可能是图文）')
      const desc = clipTitle(asString(data.content) || asString(data.title) || title)
      let height = 0
      const media = Array.isArray(data.media) ? data.media : []
      for (const it of media) {
        if (!isObj(it) || !asString(it.url)) continue
        const typ = asString(it.type)
        if (typ && typ !== 'video') continue
        height = anyInt(it.height)
        break
      }
      this.enqueueAll([{
        provider: 'douyin',
        title: desc,
        series: desc,
        vid: vid || asString(data.id),
        url: link,
        season: 0,
        episode: 0,
        height,
        quality: height > 0 ? `${height}p` : '',
        group: '',
        codec: 'H264',
        tmdbId: 0,
        nameDots: '',
        year: 0,
        plot: '',
      }])
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), 'err')
      this.emit()
    }
  }
  private async search(provider: string, q: string): Promise<void> {
    if (!this.cli) return
    try {
      const data = await this.work(() => this.cli!.invoke(provider, 'search', { q, pageSize: 20 }))
      this.rows = parseSearch(provider, data)
      this.cursor = 0
      this.say(this.rows.length ? `${this.rows.length} 条 · ${provider}` : '没有搜到结果', this.rows.length ? 'ok' : 'warn')
      this.scene = 'results'
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), 'err')
    }
    this.emit()
  }

  private async rank(): Promise<void> {
    if (!this.cli) return
    const ps = this.providers()
    let p = 'hongguo'
    for (const x of ps) {
      if (x === 'youku' || x === 'tencent' || x === 'hongguo') { p = x; break }
    }
    try {
      const data = await this.work(() => this.cli!.invoke(p, 'browse', { mode: 'rank', pageSize: 20 }))
      this.rows = parseSearch(p, data)
      this.cursor = 0
      this.say(this.rows.length ? `榜单 ${this.rows.length} 条 · ${p}` : '榜单是空的', this.rows.length ? 'ok' : 'warn')
      this.scene = 'results'
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), 'err')
    }
    this.emit()
  }

  private async detail(provider: string, id: string): Promise<void> {
    if (!this.cli) return
    const trimmed = id.trim()
    if (!trimmed || trimmed === '<nil>' || trimmed === 'null') {
      this.say('这条没有剧 ID，换一条', 'warn')
      this.emit()
      return
    }
    const input: Record<string, unknown> = { id: trimmed }
    if (provider === 'hongguo') input.seriesId = trimmed
    else if (provider === 'youku') { input.showId = trimmed; input.all = '1' }
    else if (provider === 'tencent') input.cid = trimmed
    try {
      const data = await this.work(() => this.cli!.invoke(provider, 'detail', input))
      this.detailTitle = asString(data.title)
      this.eps = parseEps(data)
      this.detailInfo = parseDetail(data, provider, this.detailTitle)
      this.cursor = 0
      this.probeFailed = false
      this.scene = 'detail'
      this.say(this.eps.length ? `${this.detailTitle} · ${this.eps.length} 集` : '这部剧没有返回剧集', this.eps.length ? 'ok' : 'warn')
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), 'err')
    }
    this.emit()
  }

  private startQRPoll(): void {
    this.stopQR()
    this.qrTimer = setInterval(() => { void this.pollQR() }, 2000)
  }

  private stopQR(): void {
    if (this.qrTimer) { clearInterval(this.qrTimer); this.qrTimer = null }
  }

  private async pollQR(): Promise<void> {
    if (this.scene !== 'qr' || !this.cli || !this.qrTicket) return
    try {
      const sign = await pollYoukuQR(this.cli, this.qrTicket)
      if (sign) {
        this.cfg.youkuSign = sign
        saveConfig(this.cfg)
        this.say('已保存 Yk-Sign', 'ok')
        this.scene = 'settings'
        this.stopQR()
        this.emit()
      }
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), 'err')
      this.emit()
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

function parseSearch(provider: string, data: Record<string, unknown>): Row[] {
  const arr = Array.isArray(data.list) ? data.list : Array.isArray(data.items) ? data.items : []
  const seen: Record<string, true> = {}
  const rows: Row[] = []
  for (const it of arr) {
    if (!isObj(it)) continue
    const meta = isObj(it.meta) ? it.meta : {}
    const title = firstStr(it, 'title', 'name', 'seriesName') || firstStr(meta, 'title')
    let id = firstStr(it, 'seriesId', 'showId', 'cid', 'vid', 'id') || firstStr(meta, 'seriesId', 'showId', 'cid')
    if (id === '<nil>' || id === 'null') id = ''
    const key = `${id}|${title}`
    if ((!title && !id) || seen[key]) continue
    seen[key] = true
    const tags = pickTags(it, meta)
    rows.push({
      title,
      id,
      sub: provider,
      desc: firstStr(it, 'subtitle', 'desc') || firstStr(meta, 'subTitle', 'subtitle', 'desc'),
      score: firstStr(it, 'score') || firstStr(meta, 'score'),
      tags,
    })
  }
  return rows
}

function pickTags(item: Record<string, unknown>, meta: Record<string, unknown>): string[] {
  for (const src of [item, meta]) {
    const raw = src.tags
    if (Array.isArray(raw)) {
      const tags = raw.filter((t): t is string => typeof t === 'string' && t.length > 0)
      if (tags.length) return tags.slice(0, 4)
    }
  }
  return []
}

/** Title-level metadata for the detail screen; every platform fills what it has. */
function parseDetail(data: Record<string, unknown>, provider: string, fallbackTitle: string): Detail {
  const raw = isObj(data.raw) ? data.raw : {}
  const title = asString(data.title) || asString(raw.title) || fallbackTitle
  const episodeList = Array.isArray(data.episodes) ? data.episodes : []
  const count = anyInt(data.episode_count) || anyInt(data.totalEps) || anyInt(raw.episode_count) || episodeList.length
  const drm = isObj(data.drm) ? asString(data.drm.note) || asString(data.drm.drm_type) : ''
  const tags = pickTags(data, raw)
  const score = asString(data.score) || asString(raw.score)
  return {
    title,
    desc: asString(data.desc) || asString(raw.desc) || asString(data.intro) || asString(data.description),
    category: asString(data.category) || asString(raw.category),
    tags,
    score,
    episodes: count,
    duration: anyInt(data.duration) || anyInt(raw.duration),
    vip: data.is_vip === true || raw.is_vip === true,
    drm,
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
