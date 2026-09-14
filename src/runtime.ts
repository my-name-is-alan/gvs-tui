import { loadConfig, saveConfig, type FileConfig } from './lib/config.ts'
import { GwClient, type KeyInfo } from './lib/client.ts'
import { JobHub, jobTitle, nextJobID, patchJob, type DlTask } from './lib/jobs.ts'
import { probeQualities } from './lib/quality.ts'
import { runTunnel } from './lib/tunnel.ts'
import { hostIsLocal, importYoukuCookie, pollYoukuQR, startYoukuQR } from './lib/youku-qr.ts'
import { tmdbSearch } from './lib/tmdb.ts'
import { dots } from './lib/name.ts'
import { asString, firstStr, isObj } from './lib/util.ts'
import type { Episode, Job, Quality, Row, Scene, Snapshot, TMDBHit } from './types.ts'

const ALL_PROVIDERS = ['youku', 'tencent', 'hongguo', 'douyin']

type Listener = (s: Snapshot) => void

export class Runtime {
  private cfg: FileConfig
  private cli: GwClient | null = null
  private keyInfo: KeyInfo | null = null
  snapshot!: Snapshot
  private scene: Scene
  private status = ''
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
    const items = ['搜索']
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

  private footer(): string {
    switch (this.scene) {
      case 'setup': return 'Tab 切换    Enter 进入'
      case 'home': return 'j/k 移动    Enter 打开    q 退出'
      case 'search': return '←/→ 平台    Enter 搜索    Esc 返回'
      case 'results':
      case 'tmdb': return 'j/k 移动    Enter 确认    Esc 返回'
      case 'detail': return '方向键    空格勾选    a全选    c清空    d下选中    A全集    Enter本集'
      case 'quality': return 'j/k 选择画质    Enter 下载    Esc 返回'
      case 'jobs': return 'Esc 返回'
      case 'settings': return 'j/k 移动    Enter 修改    空格 开关    Esc 返回'
      case 'qr': return '手机扫码    Esc 取消'
      case 'edit': return 'Enter 保存    Esc 取消'
      default: return ''
    }
  }

  private build(): Snapshot {
    const cursor = this.scene === 'quality' ? this.qIdx : this.scene === 'settings' ? this.setIdx : this.cursor
    return {
      scene: this.scene,
      host: this.cfg.host,
      status: this.status,
      tunnelOk: this.tunnelOk,
      tunnelError: this.tunnelErr || undefined,
      cursor,
      providerIndex: this.provIdx,
      qualityIndex: this.qIdx,
      providers: this.providers(),
      homeItems: this.homeItems(),
      rows: this.rows,
      episodes: this.eps,
      qualities: this.qualities,
      tmdbHits: this.tmdbHits,
      jobs: this.jobs,
      settings: this.settingFields().map((label) => ({ label, value: this.settingValue(label) })),
      detailTitle: this.detailTitle,
      pendingCount: this.pending.length,
      query: this.query,
      hostInput: this.hostInput,
      hostFocused: this.hostFocused,
      keyFocused: this.keyFocused,
      keyConfigured: Boolean(this.cfg.key.trim()),
      editField: this.editField,
      editValue: this.editValue,
      qrAscii: this.qrAscii,
      footer: this.footer(),
    }
  }

  private async refreshKey(): Promise<void> {
    if (!this.cli) return
    try {
      this.keyInfo = await this.cli.keyInfo()
      this.status = `${this.keyInfo.name}  scope=${this.keyInfo.all || !this.keyInfo.scope?.length ? '全部' : this.keyInfo.scope.join(',')}  ${
        this.keyInfo.permanent || !this.keyInfo.expiresAt ? '永不到期' : `剩 ${this.keyInfo.daysLeft ?? 0} 天`
      }`
      if (!this.tunnelOn && (this.has('youku') || this.has('tencent'))) {
        this.tunnelOn = true
        this.tunnelAbort = new AbortController()
        runTunnel(this.cfg.host, this.cfg.key, (ok, err) => {
          this.tunnelOk = ok
          this.tunnelErr = err
          this.status = ok ? '隧道已连接：优酷/腾讯走本机 IP' : (err ? `隧道断开 ${err}` : this.status)
          this.emit()
        }, this.tunnelAbort.signal)
      }
    } catch (e) {
      this.status = `Key 无效：${e instanceof Error ? e.message : e}`
      this.scene = 'setup'
      this.hostFocused = false
      this.keyFocused = true
    }
    this.emit()
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
      this.status = '请填写 API Key'
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
      void this.search(ps[this.provIdx] ?? 'hongguo', q)
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
      this.status = `已选 ${n} 集`
    } else if (k === 'c') {
      for (const ep of this.eps) ep.selected = false
      this.status = '已清空选择'
    } else if (k === 'enter' || k === 'd') {
      const tasks = this.selectedTasks()
      void this.queueEpisodes(tasks.length ? tasks : [this.taskFromEp(this.cursor)])
    } else if (k === 'A' || k === 'f') {
      void this.queueEpisodes(this.eps.map((_, i) => this.taskFromEp(i)))
    }
  }

  private updateQuality(k: string): void {
    const n = this.qualities.length
    if (k === 'esc') { this.scene = 'detail'; return }
    if (n && (k === 'j' || k === 'down')) this.qIdx = (this.qIdx + 1) % n
    else if (n && (k === 'k' || k === 'up')) this.qIdx = (this.qIdx - 1 + n) % n
    else if (k === 'enter' && n) {
      const q = this.qualities[this.qIdx]
      for (const t of this.pending) {
        t.quality = q.id
        t.group = this.cfg.releaseGroup
        if (q.height > 0) t.height = q.height
        if (q.codec) t.codec = q.codec
      }
      this.status = `画质 ${q.label}`
      void this.afterQuality()
    }
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
      this.status = this.tunnelOk ? '隧道已连接' : (this.tunnelErr || '未连接')
      this.emit()
      return
    }
    if (f === '优酷扫码') {
      if (!this.cli) return
      this.status = hostIsLocal(this.cfg.host) ? '本机网关，扫码从家庭 IP 出去。' : '扫码从本机 IP 出网（隧道）。'
      try {
        const qr = await startYoukuQR(this.cli)
        this.qrTicket = qr.ticket
        this.qrAscii = qr.ascii
        this.scene = 'qr'
        this.startQRPoll()
      } catch (e) {
        this.status = e instanceof Error ? e.message : String(e)
        this.scene = 'settings'
      }
      this.emit()
      return
    }
    if (f === 'Yk-Sign') {
      this.status = '登录态由扫码或导入 Cookie 写入，不能手改。'
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
        if (!v) { this.status = 'Cookie 为空'; this.scene = 'settings'; this.emit(); return }
        if (!this.cli) return
        this.scene = 'settings'
        this.status = '正在导入优酷 Cookie…'
        this.emit()
        try {
          this.cfg.youkuSign = await importYoukuCookie(this.cli, v)
          saveConfig(this.cfg)
          this.status = '优酷 Cookie 已导入'
        } catch (e) {
          this.status = `Cookie 导入失败：${e instanceof Error ? e.message : e}`
        }
        this.emit()
        return
    }
    saveConfig(this.cfg)
    this.status = `${this.editField} 已保存`
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
    this.pending = tasks
    this.status = '正在取画质…'
    this.emit()
    try {
      const list = await probeQualities(this.cli, this.cfg, this.detailProv, tasks[0].vid)
      if (!list.length) {
        this.status = '没有画质列表，使用默认画质'
        await this.afterQuality()
        return
      }
      this.qualities = list
      this.qIdx = 0
      this.scene = 'quality'
      this.status = `${list.length} 档 · ${tasks.length} 集`
    } catch (e) {
      this.status = `画质不可用，使用默认画质：${e instanceof Error ? e.message : e}`
      await this.afterQuality()
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
        this.status = `TMDB: ${e instanceof Error ? e.message : e}`
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
    this.status = `已加入 ${tasks.length} 个任务`
    this.emit()
  }

  private async search(provider: string, q: string): Promise<void> {
    if (!this.cli) return
    try {
      const data = await this.cli.invoke(provider, 'search', { q, pageSize: 20 })
      this.rows = parseSearch(provider, data)
      this.cursor = 0
      this.status = `${this.rows.length} 条`
      this.scene = 'results'
    } catch (e) {
      this.status = e instanceof Error ? e.message : String(e)
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
      const data = await this.cli.invoke(p, 'browse', { mode: 'rank', pageSize: 20 })
      this.rows = parseSearch(p, data)
      this.cursor = 0
      this.status = `${this.rows.length} 条`
      this.scene = 'results'
    } catch (e) {
      this.status = e instanceof Error ? e.message : String(e)
    }
    this.emit()
  }

  private async detail(provider: string, id: string): Promise<void> {
    if (!this.cli) return
    const trimmed = id.trim()
    if (!trimmed || trimmed === '<nil>' || trimmed === 'null') {
      this.status = '这条没有剧 ID，换一条'
      this.emit()
      return
    }
    const input: Record<string, unknown> = { id: trimmed }
    if (provider === 'hongguo') input.seriesId = trimmed
    else if (provider === 'youku') { input.showId = trimmed; input.all = '1' }
    else if (provider === 'tencent') input.cid = trimmed
    try {
      const data = await this.cli.invoke(provider, 'detail', input)
      this.detailTitle = asString(data.title)
      this.eps = parseEps(data)
      this.cursor = 0
      this.scene = 'detail'
    } catch (e) {
      this.status = e instanceof Error ? e.message : String(e)
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
        this.status = '已保存 Yk-Sign'
        this.scene = 'settings'
        this.stopQR()
        this.emit()
      }
    } catch (e) {
      this.status = e instanceof Error ? e.message : String(e)
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
    const title = firstStr(it, 'title', 'name', 'seriesName')
    let id = firstStr(it, 'seriesId', 'showId', 'cid', 'vid', 'id')
    if (id === '<nil>' || id === 'null') id = ''
    const key = `${id}|${title}`
    if ((!title && !id) || seen[key]) continue
    seen[key] = true
    rows.push({ title, id, sub: provider })
  }
  return rows
}

function parseEps(data: Record<string, unknown>): Episode[] {
  const arr = Array.isArray(data.episodes) ? data.episodes : []
  const eps: Episode[] = []
  for (const [i, it] of arr.entries()) {
    if (!isObj(it)) continue
    let n = i + 1
    if (typeof it.ep === 'number') n = it.ep
    else if (typeof it.stage === 'string') {
      const x = Number.parseInt(it.stage, 10)
      if (Number.isFinite(x)) n = x
    }
    eps.push({ title: firstStr(it, 'title', 'name'), vid: firstStr(it, 'vid', 'id'), number: n, selected: false })
  }
  return eps
}
