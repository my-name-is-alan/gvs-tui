import { resolveManifest, requireClearDownload } from './manifest-provider.ts'
import { userMessage } from './user-message.ts'
import { youkuMediaError } from './media-output.ts'
import { decryptYoukuTs } from './youku-ts.ts'
import { tencentPlayInput } from './tencent-qr.ts'
import { tencentAudioDownloadPlan, tencentAudioPlanNote, tencentCatalogProbeInput, tencentPlayQualityInput } from './quality.ts'
import { equivalentTencentRendition } from './tencent-rendition-resolution.ts'
import { resolveHongguoDownload } from './hongguo.ts'
import { huangguoKeyMode, resolveHuangguoDownload } from './huangguo.ts'
import { mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, extname, join } from 'node:path'
import type { FileConfig } from './config.ts'
import type { GwClient } from './client.ts'
import { audioTrackLabel, ffmpegDecryptCopy, ffmpegRemux, validateAudio, validateVideoDecode } from './ffmpeg.ts'
import { mkvmergeMux, mkvmergeRemux, type MuxAudio } from './mkvmerge.ts'
import { ensureFFmpeg, ensureMkvmerge, ensureMP4Box } from './tools.ts'
import { isDtsAudio, mp4boxMux, readMp4Tracks } from './mp4box.ts'
import { episodeTitle, filename, folder, sourceTag } from './name.ts'
import type { MediaKind, Naming } from './name.ts'
import { writeEpisodeNFO, writeTvShowNFO } from './nfo.ts'
import {
  CdnDenied, downloadPlaylist, downloadProgress, firstLivePlaylist, hlsSegmentsEncrypted, pickDouyinURL, pickTencentDownload, playlistStatus, referer, speedCB,
  youkuAudioPlaylist, youkuAudioStreamType, youkuSpokenLangKey, youkuUsesSeparateAudio, youkuVideoPlaylist,
} from './media.ts'
import type { HlsCipher, RetryNote, ProgressCB } from './media.ts'
import { retryCdnRefresh } from './cdn-retry.ts'
import { asString, human, isObj } from './util.ts'
import type { Job, TencentQualitySelection, IQCNQualitySelection } from '../types.ts'
import { tencentDownloadSelection } from './tencent-quality-selection.ts'
import { moveFileSync } from './file-move.ts'
import { downloadIQ } from './iq.ts'
import { downloadIQCN } from './iqcn.ts'
import { youkuPlayInput } from './youku-play-input.ts'
import type { IQCNLocalRuntime } from './iqcn-local.ts'
import { runLog } from './runlog.ts'
import { prepareAudioLanguage } from './audio-language.ts'
import type { TmdbDetails } from './tmdb.ts'
import { actualVersionText, tencentActualVersion, type ActualVersion } from './actual-version.ts'
import { verifyTencentCoverage, verifyTencentSpecs } from './tencent-output.ts'
import { tencentChoiceSelection } from './tencent-quality-selection.ts'
import { finishedMediaRecord, finishedVersionRecord, saveVersionRecord } from './gvs-record.ts'
import { finalizeCompletedName, reserveOutputPath, tencentNamingEvidence, usesMeasuredNaming, youkuNamingEvidence, type NamingEvidence } from './completed-naming.ts'
import { defaultAudioIndex, orderedMuxAudios } from './audio-selection.ts'
import type { CompletedMedia, MediaSpecs } from './actual-version.ts'

export type DlTask = {
  tencentPlayParams?: import('../types.ts').TencentPlayParams
  provider: string
  title: string
  series: string
  vid: string
  url?: string
  season: number
  episode: number
  /** Per-episode runtime, retained for retries; old queues may omit it. */
  duration?: number
  height: number
  quality: string
  /** Tencent TV caption soft|hard */
  caption?: string
  /** Exact selected Tencent format/persona, retained across pause and retry. */
  tencentQuality?: TencentQualitySelection
  /** Stable domestic rendition attributes, with the original probe episode. */
  iqcnQuality?: IQCNQualitySelection
  /** New tasks opt into measured naming; old saved queues intentionally omit this version. */
  namingVersion?: 1
  namingEvidence?: NamingEvidence
  /** Pinned at task creation so pause/retry keeps the same name. Legacy tasks include titles. */
  includeEpisodeTitle?: boolean
  /** Audio tracks to mux in (空格勾选的那些）；空 = 只封平台默认音轨。 */
  audioTracks?: Array<{ id: string; label: string; lang: string; vid?: string; codec?: string; isDefault?: boolean }>
  group: string
  codec: string
  tmdbId: number
  /** Details of the explicitly matched TMDB title, retained for resume/retry. */
  tmdbMetadata?: TmdbDetails
  nameDots: string
  year: number
  plot: string
  kind?: MediaKind
  collection?: string
  edition?: string
  languages?: Array<{ vid: string; lang: string }>
}

/** note: non-fatal warning on a finished job, e.g. a skipped audio track. */
export type JobEvt = {
  id: number
  status: string
  pct: number
  log: string
  err: string
  done?: boolean
  note?: string
  /** Present only on successful completion; requested quality remains separate. */
  actualVersion?: ActualVersion
  completedMedia?: CompletedMedia
  /** Final event only: the user stopped the job instead of it failing. */
  stopped?: 'pause' | 'cancel'
}

/** What a stop request asks for: keep the work dir (pause) or discard it (cancel). */
export type StopReason = 'pause' | 'cancel'

/** Lets the hub release per-provider resources as soon as downloading is done. */
export type JobHooks = { downloaded?: () => void }

type JobRunner = (
  emit: (e: JobEvt) => void,
  cfg: FileConfig,
  cli: GwClient,
  id: number,
  t: DlTask,
  signal?: AbortSignal,
  hooks?: JobHooks,
) => Promise<void>

type QueuedJob = { id: number; provider: string; run: (signal: AbortSignal, hooks: JobHooks) => Promise<void> }

export function youkuDRM(payload: Record<string, unknown>) {
  const drm = isObj(payload.drm) ? payload.drm : {}
  const key = asString(drm.content_key_hex).replace(/^0x/i, '').replace(/-/g, '').toLowerCase()
  const kid = (asString(drm.kid) || asString(drm.key_id)).replace(/^0x/i, '').replace(/-/g, '').toLowerCase()
  const clear = drm.actually_clear === true || drm.need_decrypt === false
  // 0:0 is full-block CBC encryption, NOT a clear audio track.
  return { reKey: key ? (/^[a-f\d]{32}$/i.test(kid) ? `${kid}:${key}` : key) : '', videoEnc: !clear, audioEnc: !clear }
}

/** Tencent segments carry no EXT-X-KEY; enc=1 ChaCha20 needs the gateway key/IV
 * passed to RE explicitly, otherwise the "video" is ciphertext ffmpeg cannot open. */
export function tencentCipher(payload: Record<string, unknown>): HlsCipher | undefined {
  const drm = isObj(payload.drm) ? payload.drm : {}
  const enc = Number(drm.enc) || 0
  if (drm.need_decrypt !== true && !enc) return undefined
  if (enc === 2) throw new Error('腾讯该集为 Widevine 加密，当前不支持下载')
  const key = asString(drm.content_key_hex) || asString(drm.content_key_b64)
  const iv = asString(drm.iv_hex) || asString(drm.iv_b64)
  if (enc !== 1 || !key || !iv) {
    // The gateway's reason, e.g. "chacha20.js not found: ..." on a fresh deploy.
    const why = asString(drm.note)
    throw new Error(`腾讯该集已加密（enc=${enc}），但网关没有返回可用密钥${why ? `：${why}` : ''}`)
  }
  if (cipherBytesAllZero(key) || cipherBytesAllZero(iv)) {
    const unverified = drm.playback_verified === false ? '，且网关未验证该地址可播放' : ''
    throw new Error(`腾讯该集的解密参数无效（密钥或 IV 全为零）${unverified}`)
  }
  return { method: 'CHACHA20', key, iv }
}

/** Hex or base64 material that decodes to only 0x00. A blank key still "decrypts" into garbage ffmpeg cannot open. */
function cipherBytesAllZero(value: string): boolean {
  const raw = value.trim()
  const bytes = /^[a-f\d]+$/i.test(raw) && raw.length % 2 === 0
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64')
  return bytes.length > 0 && bytes.every((b) => b === 0)
}

let jobSeq = 0
export function nextJobID(): number {
  jobSeq += 1
  return jobSeq
}

/** Keep generated ids above an id that already exists (e.g. restored queue). */
export function seedJobID(min: number): void {
  if (Number.isFinite(min)) jobSeq = Math.max(jobSeq, Math.trunc(min))
}

export class JobHub {
  private readonly q: QueuedJob[] = []
  private active = 0
  private youkuActive = 0
  private readonly running = new Map<number, { ctrl: AbortController; settled: Promise<void> }>()

  constructor(
    private readonly onEvt: (e: JobEvt) => void,
    private readonly start: JobRunner = runTask,
  ) {}

  enqueue(cfg: FileConfig, cli: GwClient, id: number, t: DlTask): void {
    // A double click / retry must not run the same row twice.
    if (this.isActive(id)) return
    const taskClient = t.provider === 'tencent' ? cli.forkTencentJob?.(id, t.vid) ?? cli : cli
    const taskConfig = { ...cfg }
    this.q.push({
      id,
      provider: t.provider,
      run: async (signal, hooks) => {
        let failed = false
        const emit = (event: JobEvt) => { if (event.err) failed = true; this.onEvt(event) }
        try { await this.start(emit, taskConfig, taskClient, id, t, signal, hooks) }
        catch (error) { failed = true; throw error }
        finally { if (t.provider === 'tencent') await taskClient.closeTencentTransfer?.(signal?.aborted, failed).catch(() => {}) }
      },
    })
    this.pump()
  }

  /** Queued or running right now. */
  isActive(id: number): boolean {
    return this.running.has(id) || this.q.some(item => item.id === id)
  }

  /**
   * Queued: drop it, emit nothing, resolve 'queued'.
   * Running: abort with `reason` and resolve only after the runner promise has
   * settled, so a resume cannot race the old process on the same files.
   */
  async cancel(id: number, reason: StopReason = 'cancel'): Promise<'queued' | 'running' | 'none'> {
    const queuedAt = this.q.findIndex(item => item.id === id)
    if (queuedAt >= 0) {
      this.q.splice(queuedAt, 1)
      return 'queued'
    }
    const live = this.running.get(id)
    if (!live) return 'none'
    live.ctrl.abort(reason)
    await live.settled
    return 'running'
  }

  /** Stop everything that is still queued or running and wait for all runners. */
  async cancelAll(reason: StopReason = 'cancel'): Promise<void> {
    this.q.length = 0
    const live = [...this.running.values()]
    for (const { ctrl } of live) ctrl.abort(reason)
    await Promise.all(live.map(({ settled }) => settled))
  }

  private pump(): void {
    for (let i = 0; i < this.q.length && this.active < 2; ) {
      const item = this.q[i]!
      // Two Youku CENC jobs share Shaka/RE temp names and one UPS session.
      // English+Mandarin editions in parallel decrypt with a mixed key.
      if (item.provider === 'youku' && this.youkuActive > 0) {
        i++
        continue
      }
      this.q.splice(i, 1)
      this.active += 1
      if (item.provider === 'youku') this.youkuActive += 1
      const ctrl = new AbortController()
      // The Youku slot guards download/decrypt only: mixed RE/Shaka temp names
      // and mixed CENC keys exist while downloading, not while muxing the
      // finished tracks. Release it once the download phase reports done.
      let youkuHeld = item.provider === 'youku'
      let releaseHooks: JobHooks = {}
      const releaseYouku = () => {
        if (!youkuHeld) return
        youkuHeld = false
        this.youkuActive -= 1
        releaseHooks = {}
        this.pump()
      }
      releaseHooks = { downloaded: releaseYouku }
      const hooks: JobHooks = { downloaded: () => releaseHooks.downloaded?.() }
      const settled = Promise.withResolvers<void>()
      this.running.set(item.id, { ctrl, settled: settled.promise })
      void item.run(ctrl.signal, hooks).finally(() => {
        if (youkuHeld) {
          youkuHeld = false
          this.youkuActive -= 1
        }
        this.active -= 1
        this.running.delete(item.id)
        settled.resolve()
        this.pump()
      })
    }
  }
}

export function jobTitle(t: DlTask): string {
  if (t.provider === 'douyin') {
    const title = t.series || t.title || t.vid
    return t.quality ? `${title} ${t.quality}` : title
  }
  if (t.kind === 'movie') {
    let title = t.series
    if (t.edition) title += ` ${t.edition}`
    if (t.quality) title += ` ${t.quality}`
    return title
  }
  let title = `${t.series} E${String(t.episode).padStart(2, '0')}`
  const subtitle = episodeTitle(t.title, t.series, t.nameDots)
  if (subtitle) title += ` ${subtitle}`
  if (t.quality) title += ` ${t.quality}`
  return title
}

/** The confirmation preview and the downloader use the same naming fields. */
export function jobNaming(t: DlTask, cfg: FileConfig): Naming {
  return {
    kind: t.kind ?? (t.provider === 'hongguo' || t.provider === 'huangguo' || t.provider === 'douyin' ? 'short' : 'show'),
    title: t.series || t.title,
    nameDots: t.nameDots,
    year: t.year,
    season: t.season,
    episode: t.episode,
    episodeTitle: t.includeEpisodeTitle === false ? undefined : t.title,
    height: t.height,
    codec: t.codec || 'H264',
    edition: t.edition,
    collection: t.collection,
    source: sourceTag(t.provider),
    group: t.provider === 'douyin' ? '' : (t.group.trim() || cfg.releaseGroup),
    tmdbId: t.tmdbId,
    container: t.provider === 'douyin' || (t.provider === 'youku' && t.audioTracks?.some(isDtsAudio))
      ? 'mp4' : t.provider === 'hongguo' && cfg.hongguoFmt ? cfg.hongguoFmt
        : t.provider === 'huangguo' && cfg.huangguoFmt ? cfg.huangguoFmt : 'mkv',
  }
}

export async function runTask(
  emitEvt: (e: JobEvt) => void,
  cfg: FileConfig,
  cli: GwClient,
  id: number,
  t: DlTask,
  signal?: AbortSignal,
  hooks?: JobHooks,
  iqcnRuntime?: IQCNLocalRuntime,
): Promise<void> {
  // Surface CDN retries in the job row instead of letting the bar sit still.
  let lastPct = 0
  const emit = (status: string, pct: number, log: string) => {
    lastPct = Math.max(lastPct, Math.min(0.99, Number.isFinite(pct) ? pct : lastPct))
    emitEvt({ id, status, pct: lastPct, log, err: '' })
  }
  const retryNote = (attempt: number, total: number, why: string) => {
    emitEvt({ id, status: '重试', pct: lastPct, log: `第 ${attempt}/${total} 次 · ${why}`, err: '' })
  }
  const log = (msg: string) => runLog(`job ${id} ${t.provider} ${msg}`)
  let dir = ''
  let out = ''
  let ownsOutput = false
  let succeeded = false
  let actualVersion: ActualVersion | undefined
  let completedMedia: CompletedMedia | undefined
  try {
    signal?.throwIfAborted()
    let audioLanguageFallback = ''
    try {
      if (t.tmdbId && (t.provider === 'youku' || t.provider === 'tencent')) {
        emit('元数据', 0, '读取 TMDB 制作地区与原始语言')
        audioLanguageFallback = await prepareAudioLanguage(cfg, t, signal)
        log(`audio language fallback=${audioLanguageFallback || 'none'} tmdb=${t.tmdbId} countries=${t.tmdbMetadata?.countries.join(',') || 'unknown'}`)
      }
    } catch (e) {
      signal?.throwIfAborted()
      // Metadata failure must not fail a paid download or guess its language.
      log(`TMDB 音轨语言查询失败，保留原标签：${e instanceof Error ? e.message : '查询失败'}`)
    }
    const n = jobNaming(t, cfg)
    dir = t.provider === 'douyin' ? cfg.outDir : folder(n, cfg.outDir)
    mkdirSync(dir, { recursive: true })
    out = join(dir, filename(n))
    if (usesMeasuredNaming(t)) { out = reserveOutputPath(out); ownsOutput = true }
    // All intermediates live in one deterministic per-task folder so a resume
    // finds its `.partN` / RE scratch, and so the user can put that folder on
    // another volume instead of filling the system drive.
    const work = jobWorkDir(cfg, t)
    mkdirSync(work, { recursive: true })
    log(`work dir ${work}`)
    let note = ''
    const ffmpeg = t.provider === 'hongguo' || t.provider === 'huangguo' ? await ensureFFmpeg() : ''
    const mkvmerge = n.container === 'mkv' ? await ensureMkvmerge() : ''
    if (n.container === 'mkv' && !mkvmerge) throw new Error('没有 mkvmerge')
    emit('取链', 0.01, out.split(/[/\\]/).pop() ?? out)
    switch (t.provider) {
      case 'iqcn':
        note = await downloadIQCN(cli, t, out, work, emit, signal, iqcnRuntime, cfg.threads, { reservedOutput: ownsOutput })
        break
      case 'iq':
        note = await downloadIQ(cli,cfg,t,out,work,emit,signal)
        break
      case 'mewatch': case 'hamivideo':
        await dlManifestProvider(cli, cfg, t, out, emit, work, signal)
        break
      case 'hongguo':
        await dlHongguo(cli, t, out, ffmpeg, mkvmerge, emit, retryNote, cfg.threads, work, signal)
        break
      case 'huangguo':
        await dlHuangguo(cli, t, out, ffmpeg, mkvmerge, emit, retryNote, cfg.threads, work, signal)
        break
      case 'youku':
        out = await dlYouku(cli, cfg, t, dir, out, mkvmerge, emit, retryNote, work, signal, hooks, audioLanguageFallback)
        break
      case 'tencent':
        note = await dlTencent(cli, cfg, t, out, mkvmerge, emit, retryNote, work, signal, audioLanguageFallback, version => {
          actualVersion = version
          if (usesMeasuredNaming(t)) t.namingEvidence = tencentNamingEvidence(version)
          log(actualVersionText(version))
        })
        break
      case 'douyin':
        await dlDouyin(cli, t, out, emit, retryNote, cfg.threads, signal)
        break
      default:
        throw new Error(`demo 尚未接 ${t.provider} 下载管线`)
    }
    signal?.throwIfAborted()
    let finishedMedia: MediaSpecs | undefined
    if (usesMeasuredNaming(t)) {
      emit('命名', 0.99, '读取实际视频规格和默认音轨')
      const named = await finalizeCompletedName(out, n, t.namingEvidence, signal)
      out = named.output
      finishedMedia = named.media
      if (named.note) { note = [note, named.note].filter(Boolean).join('；'); log(named.note) }
    }
    if ((t.provider === 'hongguo' && cfg.hongguoNfo) || (t.provider === 'huangguo' && cfg.huangguoNfo)) {
      writeTvShowNFO(dirname(dir), n.title, t.plot, 0)
      writeEpisodeNFO(out, t.title, Math.max(t.season, 1), t.episode, '')
    }
    if (actualVersion) {
      emit('记录版本', 0.99, actualVersionText(actualVersion))
      try {
        const finished = await finishedVersionRecord(out, actualVersion, signal, finishedMedia)
        actualVersion = finished
        saveVersionRecord(out, finished)
      } catch {
        signal?.throwIfAborted()
        // Media is already complete. Keep provenance in jobs.json if the separate archive cannot be written.
        note = [note, '版本档案未能保存'].filter(Boolean).join('；')
        log('版本档案未能保存')
      }
    }
    if (['youku', 'iq', 'iqcn'].includes(t.provider)) {
      try {
        completedMedia = await finishedMediaRecord(out, signal, finishedMedia)
      } catch {
        signal?.throwIfAborted()
        note = [note, '视频规格未能记录'].filter(Boolean).join('；')
        log('视频规格未能记录')
      }
    }
    signal?.throwIfAborted()
    succeeded = true
    emitEvt({ id, status: '完成', pct: 1, log: out, err: '', done: true, note, actualVersion, completedMedia })
  } catch (e) {
    // A stop is not a failure: one final event carrying `stopped`, never 失败.
    if (signal?.aborted) {
      const reason: StopReason = signal.reason === 'pause' ? 'pause' : 'cancel'
      emitEvt({ id, status: reason === 'pause' ? '已暂停' : '已取消', pct: lastPct, log: '', err: '', done: true, stopped: reason })
      if (reason === 'cancel') {
        // Delete a truncated final output; the download stages already removed
        // the job work dir, this covers the mux stages writing straight to out.
        if (out) {
          try { unlinkSync(out) } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`删除未完成的成品失败：${(err as Error).message}`)
          }
        }
        try { await discardJobWork(cfg, t) } catch (err) { log(`清理工作目录失败：${(err as Error).message}`) }
      }
      return
    }
    runLog(`download ${id} failed: ${e instanceof Error ? e.message : String(e)}`)
    emitEvt({ id, status: '失败', pct: lastPct, log: '', err: userMessage(e), done: true })
  } finally {
    if (!succeeded && ownsOutput && out) {
      // Remove only our empty reservation; retain any completed/partial media for diagnosis.
      try { if (statSync(out).size === 0) unlinkSync(out) } catch { /* not created */ }
    }
    // Success cleans up its scratch; a failure keeps it so a retry can resume.
    if (succeeded) {
      try { await discardJobWork(cfg, t) } catch (err) { log(`清理工作目录失败：${(err as Error).message}`) }
      cleanupOutputCaches(dir)
    }
  }
}

/** Forget `.partN` of a destination whose URL/key was refreshed: those bytes
 * are not the same content, so a byte-range resume would corrupt the file. */
function dropPartFiles(dest: string): void {
  try { unlinkSync(`${dest}.parts.json`) } catch { /* first run */ }
  for (let i = 0; i < 64; i++) {
    try { unlinkSync(`${dest}.part${i}`) } catch { /* fewer parts */ }
  }
}

/**
 * Report a scratch-dir fallback in the run log. Without it a configured tmpDir
 * that cannot be created would silently put the bytes back on the system drive.
 */
function scratchLog(msg: string): void {
  runLog(`scratch ${msg}`)
}

/**
 * Write the finished file under a hidden name beside `out`, then rename it in
 * place: a pause, cancel or crash mid-write never leaves a truncated file that
 * looks finished. Same folder and extension, so tools pick the same muxer.
 */
async function writeFinal(out: string, write: (dest: string) => Promise<void>): Promise<void> {
  const ext = extname(out)
  const partial = join(dirname(out), `.${basename(out, ext)}.partial${ext}`)
  try {
    await write(partial)
    moveFileSync(partial, out)
  } catch (e) {
    try { unlinkSync(partial) } catch { /* never written */ }
    throw e
  }
}

async function dlHongguo(
  cli: GwClient, t: DlTask, out: string, ffmpeg: string, mkvmerge: string,
  emit: (s: string, p: number, l: string) => void,
  retryNote: RetryNote,
  threads: number,
  work: string,
  signal?: AbortSignal,
): Promise<void> {
  emit('取链', 0.02, t.vid)
  let picked = await resolveHongguoDownload(cli, t.vid, t.quality)
  signal?.throwIfAborted()
  const safe = t.vid.replace(/[^\w.-]+/g, '_')
  const enc = join(work, `.${safe}.enc.mp4`)
  const tmp = join(work, `.${safe}.mp4`)
  emit('下载', 0.08, '')
  const pull = () => downloadProgress(picked.cdn, enc, referer(t.provider), speedCB(emit, '下载', 0.08, 0.7), retryNote, threads, undefined, undefined, signal)
  try {
    await pull()
  } catch (e) {
    signal?.throwIfAborted()
    // CDN 拒绝旧链接时重新获取成对的 URL 和 key。
    if (!(e instanceof CdnDenied)) throw e
    emit('重取', 0.08, `CDN ${e.status}，重新取链后下载`)
    const previousKey = picked.key
    picked = await resolveHongguoDownload(cli, t.vid, t.quality)
    signal?.throwIfAborted()
    // Encrypted bytes are identical across a URL refresh only while the key
    // is: a new key means the old .partN no longer describes this download.
    // (A mere URL change is already handled by the resume identity hash.)
    if (picked.key !== previousKey) dropPartFiles(enc)
    await pull()
  }
  // mp4 成品不需要换容器：解密（或搬移）直接写到成品路径，省掉一次整文件复写。
  const direct = !!ffmpeg && !mkvmerge
  const materialize = direct ? out : tmp
  emit('解密', 0.78, '')
  if (picked.key) {
    const decrypt = (dest: string) => ffmpegDecryptCopy(ffmpeg, picked.key, enc, dest, (n, total) => emit('解密', 0.78 + 0.07 * Math.min(1, n / total), `解密 ${human(n)}/${human(total)}`), signal)
    if (direct) await writeFinal(out, decrypt)
    else await decrypt(tmp)
    try { unlinkSync(enc) } catch { /* keep */ }
  } else {
    moveFileSync(enc, materialize)
  }
  if (direct) return
  const remux = (n: number, total: number) => emit('封装', 0.86 + 0.13 * (n / total), `封装 ${human(n)}/${human(total)}`)
  try {
    await writeFinal(out, (dest) => mkvmerge ? mkvmergeRemux(mkvmerge, tmp, dest, remux, signal) : ffmpegRemux(ffmpeg, tmp, dest, remux, signal))
  } catch (e) {
    if (signal?.aborted) throw e
    moveFileSync(tmp, out.slice(0, out.length - extname(out).length) + '.mp4')
    throw new Error('封装失败')
  }
  try { unlinkSync(tmp) } catch { /* keep */ }
}

/**
 * 黄果：网关只给「一条直链 + AES-128 key + headers」。
 * - HLS：N_m3u8DL-RE 直连 CDN，用 `--custom-hls-key` 解密（key 由网关取好，
 *   所以不需要 CDN 上的 key URI，也不需要本地转发）。
 * - 直链 mp4：按普通文件下载；带 key 时先 ffmpeg 解一次。
 * 中间文件写进 job 工作目录（分集 ID 里有冒号，不能直接当文件名）。
 */
async function dlHuangguo(
  cli: GwClient, t: DlTask, out: string, ffmpeg: string, mkvmerge: string,
  emit: (s: string, p: number, l: string) => void,
  retryNote: RetryNote,
  threads: number,
  work: string,
  signal?: AbortSignal,
): Promise<void> {
  emit('取链', 0.02, t.vid)
  const safe = t.vid.replace(/[^\w.-]+/g, '_')
  let picked = await resolveHuangguoDownload(cli, t.vid, t.quality)
  signal?.throwIfAborted()
  // 声明加密却拿不到密钥：直接失败，绝不裸下密文（旧版会静默 clear 裸下 → 花屏）。
  let keyMode = huangguoKeyMode(picked.key, picked.keyInfo)
  if (keyMode.mode === 'error') throw new Error(keyMode.message)
  let hls = /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(picked.url)
  const raw = join(work, `.${safe}.src${hls ? '.ts' : '.mp4'}`)
  const dec = join(work, `.${safe}.dec.mp4`)
  const pull = async () => {
    hls = /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(picked.url)
    const ref = picked.headers.Referer || picked.headers.referer || referer(t.provider)
    emit('下载', 0.08, keyMode.mode === 'native' ? '检测到密钥轮换/明文段，逐段取钥' : '')
    if (!hls) {
      await downloadProgress(picked.url, raw, ref, speedCB(emit, '下载', 0.08, 0.72), retryNote, threads, undefined, picked.headers, signal)
      return
    }
    await downloadPlaylist({
      src: picked.url,
      dest: raw,
      ref,
      headers: picked.headers,
      // custom：网关单 key 直压；native：不传 key，RE 按播放列表逐段取钥、
      // 原生处理轮换和 METHOD=NONE（取钥 403 会大声失败，好过静默花屏）。
      key: keyMode.mode === 'custom' ? keyMode.key : undefined,
      keyMethod: 'AES_128',
      clear: keyMode.mode === 'clear',
      threads,
      select: 'muxed',
      transport: 're',
      workDir: work,
      workTag: 'hls',
      log: scratchLog,
      signal,
      cb: (n, total, info) => {
        const pct = total > 1 ? n / total : n
        const status = playlistStatus('下载', info?.phase ?? 'download')
        emit(status, 0.08 + 0.72 * pct, info?.log || status)
      },
    })
  }
  /** 下载 → 解密 → 校验 → 封装。校验失败抛 HuangguoCorrupt，由外层换 native 重试。 */
  const produce = async (): Promise<void> => {
    try {
      await pull()
    } catch (e) {
      signal?.throwIfAborted()
      // CDN 拒绝旧链接时重新取链，链接与 key 必须成对刷新。
      if (!(e instanceof CdnDenied)) throw e
      emit('重取', 0.08, `CDN ${e.status}，重新取链后下载`)
      picked = await resolveHuangguoDownload(cli, t.vid, t.quality)
      signal?.throwIfAborted()
      keyMode = huangguoKeyMode(picked.key, picked.keyInfo)
      if (keyMode.mode === 'error') throw new Error(keyMode.message)
      // The HLS path restarts RE in a deterministic folder that downloadPlaylist
      // empties first, so the stale file is replaced rather than appended to.
      await pull()
    }
    // 直链 mp4 + 不换容器：解密（或搬移）直接写到成品路径，跳过 mp4→mp4 复写。
    if (!hls && !mkvmerge) {
      let final = raw
      if (picked.key && ffmpeg) {
        emit('解密', 0.78, '')
        await ffmpegDecryptCopy(ffmpeg, picked.key, raw, dec, (n, total) => emit('解密', 0.78 + 0.07 * Math.min(1, n / total), `解密 ${human(n)}/${human(total)}`), signal)
        final = dec
        try { unlinkSync(raw) } catch { /* keep */ }
      }
      if (ffmpeg) await validateHuangguo(ffmpeg, final, signal)
      moveFileSync(final, out)
      return
    }
    let muxSource = raw
    if (!hls && picked.key && ffmpeg) {
      emit('解密', 0.78, '')
      await ffmpegDecryptCopy(ffmpeg, picked.key, raw, dec, (n, total) => emit('解密', 0.78 + 0.07 * Math.min(1, n / total), `解密 ${human(n)}/${human(total)}`), signal)
      muxSource = dec
    }
    if (ffmpeg) await validateHuangguo(ffmpeg, muxSource, signal)
    emit('封装', 0.86, out)
    const remux = (n: number, total: number) =>
      emit('封装', 0.86 + 0.13 * (n / Math.max(1, total)), `封装 ${human(n)}/${human(total)}`)
    await writeFinal(out, (dest) => mkvmerge && extname(out).toLowerCase() === '.mkv'
      ? mkvmergeRemux(mkvmerge, muxSource, dest, remux, signal)
      : ffmpegRemux(ffmpeg, muxSource, dest, remux, signal))
    for (const leftover of [raw, dec]) {
      try { unlinkSync(leftover) } catch { /* keep */ }
    }
  }
  try {
    await produce()
  } catch (e) {
    // custom 模式解出的画面没过解码校验：多半是网关没看到的密钥轮换，
    // 换 RE 原生逐段取钥重下一次。
    if (e instanceof HuangguoCorrupt && keyMode.mode === 'custom') {
      emit('重试', 0.86, '画面校验未过，改用逐段取钥重下')
      keyMode = { mode: 'native' }
      await produce()
    } else throw e
  }
}

/** 黄果成品解码校验未过：携带 ffmpeg 错误行，外层可换模式重试。 */
class HuangguoCorrupt extends Error {
  constructor(readonly errors: string[]) {
    super(`画面解码校验失败（${errors.length} 处错误）：${errors[0] ?? ''}`)
    this.name = 'HuangguoCorrupt'
  }
}

/** 全量解码校验：-loglevel error 下任何输出都算损坏（花屏/坏参考帧/错解密）。 */
async function validateHuangguo(ffmpeg: string, file: string, signal?: AbortSignal): Promise<void> {
  const errors = await validateVideoDecode(ffmpeg, file, signal)
  if (errors.length) throw new HuangguoCorrupt(errors)
}

/** The picked URL plus the gateway's other CDN mirrors of the same stream. */
export function tencentMirrors(data: Record<string, unknown>, picked: string): string[] {
  const v = isObj(data.video) ? data.video : {}
  const urls = (Array.isArray(v.urls) ? v.urls : Array.isArray(data.urls) ? data.urls : []).map(asString)
  // A formats[] row of another quality must not fall back to the default stream.
  return urls.includes(picked) ? [picked, ...urls.filter(u => u && u !== picked)] : [picked]
}

function logTencentDownloadHost(cdn: string, t: DlTask): void {
  try {
    const host = new URL(cdn).host
    runLog(
      `tencent download host=${host} stream=${(t.quality || '').slice(0, 24)}`,
    )
  } catch {
    /* ignore bad URL */
  }
}

async function dlTencent(
  cli: GwClient, cfg: FileConfig, t: DlTask, out: string, mkvmerge: string,
  emit: (s: string, p: number, l: string) => void,
  retryNote: RetryNote,
  work: string,
  signal?: AbortSignal,
  audioLanguageFallback = '',
  onVersion?: (version: ActualVersion) => void,
): Promise<string> {
  emit('取链', 0.05, t.vid)
  // Keep the persisted batch selection intact; only this episode's play selector changes.
  let episodeChoice = t
  let refreshes = 0
  const pickVersion = (data: Record<string, unknown>) => pickTencentDownload(data,
    { ...tencentDownloadSelection(episodeChoice), persona: tencentChoiceSelection(episodeChoice).persona }, t.vid, refreshes)
  const versionMismatch = () => new Error('腾讯返回的实际版本与所选版本不同，已停止下载；请重新取流或选择可用版本')
  const play = async () => {
    const request = async () => {
      const payload = await cli.invoke('tencent', 'play', { vid: t.vid, ...tencentPlayInput(cfg, t.tencentPlayParams), ...tencentPlayQualityInput(episodeChoice) }, cli.extra(cfg, 'tencent'))
      // The gateway call has no signal of its own; stop right after it returns.
      signal?.throwIfAborted()
      return payload
    }
    let payload = await request()
    if (pickVersion(payload).version.matchesSelection === 'different') {
      const catalog = await cli.invoke('tencent', 'play', tencentCatalogProbeInput(cfg, t.vid, t.tencentPlayParams), cli.extra(cfg, 'tencent'))
      signal?.throwIfAborted()
      const resolved = equivalentTencentRendition(episodeChoice, catalog.formats)
      if (!resolved) throw versionMismatch()
      runLog(`tencent episode rendition rebound vid=${t.vid} requested_format=${tencentChoiceSelection(t).formatId || '-'} episode_format=${resolved.formatId}`)
      episodeChoice = { ...t, tencentQuality: resolved }
      payload = await request()
      // The catalog alone does not authorize a different URL; the second play response must match.
      if (pickVersion(payload).version.matchesSelection === 'different') throw versionMismatch()
    }
    return payload
  }
  // Skip CDN mirrors that refuse this network (200 + HTML "Forbidden").
  const pick = async (data: Record<string, unknown>) => {
    const selection = tencentChoiceSelection(episodeChoice)
    const picked = pickVersion(data)
    const v = isObj(data.video) ? data.video : {}
    runLog(`tencent stream selection requested=${t.quality.split('|')[0]} format=${selection.formatId || '-'} actual=${picked.version.actual?.formatId || '-'} match=${picked.version.matchesSelection} width=${Number(v.width ?? data.width) || 0} height=${Number(v.height ?? data.height) || 0} duration=${Number(v.duration ?? data.duration) || 0}`)
    if (picked.version.matchesSelection === 'different') throw versionMismatch()
    // Missing rendition metadata is not a confirmed mismatch. Keep it unknown;
    // the existing post-download checks verify the actual video specifications and coverage.
    const cdn = picked.url && /\.m3u8/i.test(picked.url) ? await firstLivePlaylist(tencentMirrors(data, picked.url), referer('tencent'), signal) : picked.url
    if (cdn) onVersion?.(cdn === picked.url ? picked.version :
      tencentActualVersion(data, cdn, picked.version.addressSource, picked.version.selected, t.vid, refreshes))
    return cdn
  }
  let played = await play()
  let cdn = await pick(played)
  if (!cdn) throw new Error('腾讯没有可用视频地址')
  let cipher = tencentCipher(played)
  logTencentDownloadHost(cdn, t)
  // Plan audio before the video download: an episode that lacks one of the
  // picked tracks downgrades to the tracks it has instead of failing at 65%.
  let plan = tencentAudioDownloadPlan(played, t.audioTracks ?? [])
  const note = tencentAudioPlanNote(plan)
  if (note) {
    runLog(`tencent audio downgrade vid=${t.vid} ${note}`)
    emit('取链', 0.08, note)
  }
  const safe = t.vid.replace(/[^\w.-]+/g, '_')
  const raw = join(work, `.${safe}.bin`)
  const temps = [raw]
  let done = false
  const ffmpeg = await ensureFFmpeg()
  emit('下载', 0.1, '')
  const transferProgress = (): ProgressCB => {
    const display = speedCB(emit, '下载', 0.1, 0.55)
    return (n, total, info) => { cli.observeTencentTransfer(n, total); display(n, total, info) }
  }
  try {
    try {
      await downloadProgress(cdn, raw, referer('tencent'), transferProgress(), retryNote, cfg.threads, cipher, undefined, signal)
    } catch (e) {
      signal?.throwIfAborted()
      if (!(e instanceof CdnDenied)) throw e
      emit('重取', 0.1, `CDN ${e.status}，重新取链后下载`)
      refreshes += 1
      played = await play()
      cdn = await pick(played)
      if (!cdn) throw new Error('腾讯重新取链失败')
      cipher = tencentCipher(played)
      logTencentDownloadHost(cdn, t)
      // Audio playlists come from the same play response; refresh them too.
      plan = tencentAudioDownloadPlan(played, t.audioTracks ?? [])
      await downloadProgress(cdn, raw, referer('tencent'), transferProgress(), retryNote, cfg.threads, cipher, undefined, signal)
    }
    const expected = t.duration || Number(played.duration) || 0
    const videoSeconds = await verifyTencentCoverage(ffmpeg, raw, expected, signal)
    const specs = await verifyTencentSpecs(ffmpeg, raw, t.tencentQuality ?? {}, t.height, signal)
    runLog(`tencent video verified width=${specs.width} height=${specs.height} fps=${specs.fps} hdr=${specs.hdr} video_seconds=${videoSeconds.toFixed(3)} expected_seconds=${expected}`)
    if (specs.note) {
      runLog(`tencent video specification warning vid=${t.vid} ${specs.note}`)
      emit('规格提示', 0.55, specs.note)
    }
    // A long audio track must not make a truncated video look complete.
    const muxToOut = async (mux: (dest: string) => Promise<void>) => writeFinal(out, async dest => {
      await mux(dest)
      emit('验收', 0.98, '检查视频与音轨完整性')
      await verifyTencentCoverage(ffmpeg, dest, expected, signal)
      signal?.throwIfAborted()
      try { unlinkSync(`${dest}.timing.json`) } catch { /* no report */ }
    })
    if (!plan.files.length) {
      // The video stream carries its own default audio track.
      emit('封装', 0.86, out)
      await muxToOut(dest => mkvmergeRemux(mkvmerge, raw, dest, (n, total) => emit('封装', 0.86 + 0.13 * (n / total), `封装 ${human(n)}/${human(total)}`), signal, audioLanguageFallback))
      done = true
      return [note, specs.note].filter(Boolean).join('；')
    }
    const mux: MuxAudio[] = []
    for (let i = 0; i < plan.files.length; i++) {
      const audio = plan.files[i]!
      const dest = join(work, `.${safe}.a${i}.bin`)
      temps.push(dest)
      const base = 0.55 + (0.25 * i) / plan.files.length
      const span = 0.25 / plan.files.length
      emit('音轨', base, audio.label)
      // Audio playlists share the play response's key but may be clear; decide per track.
      const audioURL = await firstLivePlaylist(audio.urls, referer('tencent'), signal)
      const audioCipher = cipher && await hlsSegmentsEncrypted(audioURL, referer('tencent'), signal) ? cipher : undefined
      await downloadProgress(audioURL, dest, referer('tencent'), speedCB(emit, '音轨', base, span), retryNote, cfg.threads, audioCipher, undefined, signal)
      mux.push({ path: dest, title: audio.label, lang: audio.lang, isDefault: audio.isDefault })
    }
    const muxAudios = orderedMuxAudios(mux)
    for (const input of muxAudios) {
      const probed = await audioTrackLabel(ffmpeg, input.path)
      input.title = muxTrackTitle(input.lang ?? '', probed)
    }
    emit('封装', 0.86, out)
    const repairs: string[] = []
    await muxToOut(dest => mkvmergeMux(mkvmerge, raw, muxAudios, dest, (n, total) => emit('封装', 0.86 + 0.13 * (n / total), `封装 ${human(n)}/${human(total)}`), signal, message => {
      repairs.push(message)
      runLog(`tencent audio repair vid=${t.vid} ${message}`)
    }, audioLanguageFallback))
    if (usesMeasuredNaming(t)) t.namingEvidence = { ...t.namingEvidence, muxAudio: { index: defaultAudioIndex(muxAudios), count: muxAudios.length } }
    done = true
    return [note, specs.note, ...repairs].filter(Boolean).join('；')
  } finally {
    // Success and cancel drop the sources; a failure keeps them for diagnosis,
    // and a pause keeps them so the resume can reuse the downloaded bytes.
    if (done || signal?.reason === 'cancel') {
      for (const path of temps) {
        try { unlinkSync(path) } catch { /* keep */ }
      }
    }
    // Mux writes a timestamp report beside the finished file. Tencent has no use for the sidecar.
    if (done) {
      try { unlinkSync(`${out}.timing.json`) } catch { /* already gone */ }
    }
  }
}

async function dlDouyin(
  cli: GwClient, t: DlTask, out: string,
  emit: (s: string, p: number, l: string) => void,
  retryNote: RetryNote,
  threads: number,
  signal?: AbortSignal,
): Promise<void> {
  emit('取链', 0.02, t.vid || t.url || '')
  const url = (t.url || '').trim() || (t.vid ? `https://www.douyin.com/video/${t.vid}` : '')
  if (!url) throw new Error('没有抖音链接')
  const resolve = async () => {
    const cdn = pickDouyinURL(await cli.invoke('douyin', 'resolve', { url }))
    signal?.throwIfAborted()
    if (!cdn) throw new Error('抖音没有直链')
    return cdn
  }
  let cdn = await resolve()
  emit('下载', 0.1, cdn)
  try {
    await downloadProgress(cdn, out, referer('douyin'), speedCB(emit, '下载', 0.1, 0.85), retryNote, threads, undefined, undefined, signal)
  } catch (e) {
    signal?.throwIfAborted()
    if (!(e instanceof CdnDenied)) throw e
    emit('重取', 0.1, `CDN ${e.status}，重新解析后续传`)
    cdn = await resolve()
    await downloadProgress(cdn, out, referer('douyin'), speedCB(emit, '下载', 0.1, 0.85), retryNote, threads, undefined, undefined, signal)
  }
}

async function dlYouku(
  cli: GwClient, cfg: FileConfig, t: DlTask, dir: string, out: string, mkvmerge: string,
  emit: (s: string, p: number, l: string) => void,
  retryNote: RetryNote,
  work: string,
  signal?: AbortSignal,
  hooks?: JobHooks,
  audioLanguageFallback = '',
): Promise<string> {
  // Rebind at download time too: drafts / older queues may still carry ep1 probe vids.
  const tracks = t.audioTracks?.length
    ? bindYoukuAudioTracksToTask(t.audioTracks, t)
    : [{ id: '', label: '默认音轨', lang: '' }]
  const videoPath = join(work, `.${t.vid}.video.mp4`)
  const muxInputs: MuxAudio[] = []
  // Whether each muxed input is DTS, aligned with muxInputs. Kept separately
  // because a soft-skipped track shifts muxInputs away from `tracks`.
  const muxDts: boolean[] = []
  const temps = new Set<string>()
  const completedTracks = new Set<string>()
  let succeeded = false

  const pull = async (
    src: string,
    dest: string,
    key: string | undefined,
    label: string,
    base: number,
    span: number,
    select: 'video' | 'audio' | 'muxed',
    trackId = '',
  ) => {
    // A later audio failure must not download an already completed video again.
    // This set belongs to one task/quality and is never inferred from old files.
    if (completedTracks.has(dest)) return
    await downloadPlaylist({
      src,
      dest,
      ref: referer('youku'),
      key,
      prepareCencTs: key ? async (source, progress) => {
        const clear = source + '.youku-clear.ts'
        const mp4 = source + '.youku-clear.mp4'
        const stats = await decryptYoukuTs(source, clear, key, signal, progress)
        scratchLog(`youku TS processed audioPES=${stats.audioPES} videoPES=${stats.videoPES}`)
        await ffmpegRemux(await ensureFFmpeg(), clear, mp4, undefined, signal)
        return mp4
      } : undefined,
      clear: !key,
      threads: cfg.threads,
      select,
      transport: 'node',
      workDir: work,
      workTag: select === 'audio'
        ? `audio${trackId ? `-${trackId.replace(/[^\w-]+/g, '_')}` : ''}`
        : select === 'video' ? 'video' : 'muxed',
      log: scratchLog,
      signal,
      refreshSource: async () => {
        const payload = await playYouku(cli, cfg, t, select === 'audio' ? trackVid(t, trackId) : t.vid)
        signal?.throwIfAborted()
        const drm = youkuDRM(payload)
        const src = select === 'audio' ? youkuAudioPlaylist(payload, trackId) : youkuVideoPlaylist(payload, t.quality)
        if (!src) throw new Error('重新取链后缺少所选轨道')
        const needKey = select === 'audio' ? drm.audioEnc : drm.videoEnc
        return { src, key: needKey ? drm.reKey : undefined }
      },
      onRefresh: (retry, total) => retryNote(retry, total, `${label} 失败分片换新 CDN 链接，保留已下载进度`),
      cb: (n, total, info) => {
        const pct = total > 1 ? n / total : n
        const status = playlistStatus(label, info?.phase ?? 'download')
        emit(status, base + span * pct, info?.log || status)
      },
    })
    completedTracks.add(dest)
  }

  const run = async (payload: Record<string, unknown>) => {
    muxInputs.length = 0
    muxDts.length = 0
    temps.add(videoPath)
    temps.add(`${videoPath}.transport.json`)
    temps.add(`${videoPath}.download-error.log`)
    const drm = youkuDRM(payload)
    if ((drm.videoEnc || drm.audioEnc) && !drm.reKey) throw new Error('优酷加密轨道未返回密钥，请重试取流或检查登录状态')
    const playlist = youkuVideoPlaylist(payload, t.quality)
    if (!playlist) throw new Error('优酷 play 没有 playlist_url')
    const separateAudio = youkuUsesSeparateAudio(payload, t.quality)
    const videoAlreadyDownloaded = completedTracks.has(videoPath)
    emit('下载', 0.05, playlist.split(/[?#]/)[0]?.split('/').pop() ?? '')
    // 帧享 HQ：视频分轨下载并 drop 内嵌音；非 HQ（酷喵 TV/App）：保留视频 m3u8 自带音轨。
    await pull(
      playlist,
      videoPath,
      drm.videoEnc ? drm.reKey : undefined,
      '下载',
      0.05,
      separateAudio ? 0.62 : 0.8,
      separateAudio ? 'video' : 'muxed',
    )
    if (!videoAlreadyDownloaded && usesMeasuredNaming(t)) t.namingEvidence = youkuNamingEvidence(payload, playlist)
    if (!separateAudio) {
      // soft-skip：不强制独立音轨，避免缺 URL 失败或误复用 HQ 音轨。
      return
    }
    for (const [i, track] of tracks.entries()) {
      // Video download/decryption can outlive the original audio URL lease.
      const audioVid = trackVid(t, track.id, track.vid)
      const audioPayload = await playYouku(cli, cfg, t, audioVid)
      signal?.throwIfAborted()
      const audioDrm = youkuDRM(audioPayload)
      if (audioDrm.audioEnc && !audioDrm.reKey) throw new Error('重新取得的音轨缺少解密密钥')
      const audioPl = youkuAudioPlaylist(audioPayload, track.id, track.lang)
      if (!audioPl) {
        // HQ 约定有独立音轨；缺 URL 时 soft-skip 该条，保留已下视频。
        emit('音轨', 0.67 + 0.18 * i / tracks.length, `跳过无播放列表音轨：${track.label}`)
        continue
      }
      const audioPath = join(work, `.${t.vid}.audio${i}.mp4`)
      temps.add(audioPath)
      temps.add(`${audioPath}.transport.json`)
      temps.add(`${audioPath}.download-error.log`)
      await pull(
        audioPl,
        audioPath,
        audioDrm.audioEnc ? audioDrm.reKey : undefined,
        `音轨 ${[track.lang, track.label].filter(Boolean).join(' ')}`,
        0.67 + 0.18 * i / tracks.length,
        0.18 / Math.max(1, tracks.length),
        'audio',
        track.id,
      )
      muxInputs.push({ path: audioPath, title: track.label, lang: track.lang, isDefault: track.isDefault })
      muxDts.push(isDtsAudio(track))
    }
  }

  try {
    await retryCdnRefresh(async () => run(await playYouku(cli, cfg, t)), (retry, total, delayMs, status) => {
      retryNote(retry, total, `CDN ${status}，${delayMs / 1000} 秒后重新取链`)
    }, undefined, signal)
    signal?.throwIfAborted()
    // 下载与解密（都在 downloadPlaylist 内部）已经结束，可以让下一个优酷任务入场：
    // 冲突点是共享的 RE/Shaka 临时文件名与混用的 CENC key，封装阶段不再涉及。
    hooks?.downloaded?.()

    // Inspect the actual sample entry as well as the selected label: a default
    // track may be DTS without an explicit selection in the task.
    const mp4box = await ensureMP4Box()
    const audioInfo = await Promise.all(muxInputs.map(input => readMp4Tracks(mp4box, input.path, signal)))
    const dts = tracks.some(isDtsAudio) || audioInfo.some(list => list.some(t => /^dts[cehlxy]$/.test(t.codec)))
    if (dts && extname(out) !== '.mp4') {
      const mp4 = out.slice(0, out.length - extname(out).length) + '.mp4'
      if (usesMeasuredNaming(t)) {
        const reserved = reserveOutputPath(mp4)
        if (statSync(out).size === 0) unlinkSync(out)
        out = reserved
      } else out = mp4
    }
    emit('校验', 0.85, dts ? '检查 MP4 轨道和时间戳（DTS 使用 MP4Box）' : '检查音轨完整解码')
    const ffmpeg = await ensureFFmpeg()
    const validate = async (path: string) => {
      try {
        await validateAudio(ffmpeg, path, signal)
      } catch (e) {
        if (signal?.aborted) throw e
        throw youkuMediaError(e)
      }
    }
    // Every track was validated on its own input, so the muxed file needs no
    // second full decode — it is only needed when there is no input at all
    // (single muxed stream), and then the mp4 source is validated up front.
    const muxedOnly = muxInputs.length === 0
    await Promise.all([
      ...muxInputs.map(async (input, i) => {
        const probed = await audioTrackLabel(ffmpeg, input.path, signal)
        input.title = input.lang && input.lang !== '—' ? `${input.lang} ${probed}` : probed
        if (!muxDts[i] && !audioInfo[i]!.some(t => /^dts[cehlxy]$/.test(t.codec))) await validate(input.path)
      }),
      ...(muxedOnly && !dts ? [validate(videoPath)] : []),
    ])
    signal?.throwIfAborted()
    emit('封装', 0.86, muxInputs.length > 1 ? `封装 ${muxInputs.length} 条音轨` : out)
    const muxAudios = orderedMuxAudios(muxInputs)
    const muxProgress = (n: number, total: number) => emit('封装', 0.86 + 0.13 * (n / total), `封装 ${human(n)}/${human(total)}`)
    const partial = join(dir, `.${t.vid}.mux-partial${dts ? '.mp4' : '.mkv'}`)
    temps.add(partial)
    temps.add(`${partial}.timing.json`)
    try {
      if (dts) await mp4boxMux(mp4box, videoPath, muxAudios, partial, muxProgress, signal, audioLanguageFallback)
      else if (muxAudios.length) await mkvmergeMux(mkvmerge, videoPath, muxAudios, partial, muxProgress, signal, undefined, audioLanguageFallback)
      else await mkvmergeRemux(mkvmerge, videoPath, partial, muxProgress, signal, audioLanguageFallback)
      signal?.throwIfAborted()
      moveFileSync(partial, out)
      if (usesMeasuredNaming(t) && muxAudios.length) t.namingEvidence = { ...t.namingEvidence, muxAudio: { index: defaultAudioIndex(muxAudios), count: muxAudios.length } }
      succeeded = true
      return out
    } catch (e) {
      if (signal?.aborted) throw e
      throw youkuMediaError(e)
    }
  } finally {
    if (!succeeded && usesMeasuredNaming(t)) {
      // The detected DTS container may have changed out after the caller's reservation.
      try { if (statSync(out).size === 0) unlinkSync(out) } catch { /* no reservation remains */ }
    }
    // Failed muxes retain original tracks for diagnosis/retry. Developers can
    // opt into retaining successful downloads too, without editing config.
    if (succeeded && process.env.GVS_KEEP_INTERMEDIATES !== '1') {
      // Cleanup must never turn a finished download into a failed one.
      try { await cleanupTemporaryFiles(temps) } catch (e) { runLog(`youku cleanup ${(e as Error).message}`) }
      cleanupOutputCaches(dir)
    } else if (signal?.aborted && signal.reason === 'cancel') {
      // 取消不留中间文件；暂停保留，续传还要用。已下好的轨道保留到工作目录被
      // 整体删除为止，避免删到一半又失败时反而丢了续传状态。
      const disposable = [...temps].filter(path => path !== videoPath && !muxInputs.some(m => m.path === path))
      try { await cleanupTemporaryFiles(disposable) } catch { /* work dir removal is the backstop */ }
    }
  }
}

/** Root of every intermediate file: the configured folder, else beside the library. */
export function tmpRoot(cfg: FileConfig): string {
  return cfg.tmpDir || join(cfg.outDir, '.gvs-tmp')
}

/**
 * Deterministic per-task working folder. The same task always maps to the same
 * folder, so a resume finds the `.partN` chunks it left behind.
 */
export function jobWorkDir(cfg: FileConfig, t: DlTask): string {
  const vid = t.vid.replace(/[^\w.-]+/g, '_').slice(0, 48) || 'task'
  const identity: unknown[] = [
    t.quality ?? '',
    t.height ?? 0,
    (t.audioTracks ?? []).map(a => a.id),
    t.edition ?? '',
    t.codec ?? '',
    t.season ?? 0,
    t.episode ?? 0,
  ]
  // Preserve old resume paths, but never mix new Tencent rendition/caption chunks.
  if (t.provider === 'tencent' && t.tencentQuality) identity.push([
    t.tencentQuality.formatId || '', t.tencentQuality.persona || '', t.tencentQuality.group || '', t.caption || '',
  ])
  const key = JSON.stringify(identity)
  return join(tmpRoot(cfg), `job-${t.provider}-${vid}-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`)
}

/**
 * Remove one job's work folder, retrying the Windows EBUSY/EPERM window while a
 * killed downloader's handles close, then drop tmpRoot when it became empty.
 */
export async function discardJobWork(cfg: FileConfig, t: DlTask): Promise<void> {
  const work = jobWorkDir(cfg, t)
  let lastErr: unknown
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rmSync(work, { recursive: true, force: true })
      lastErr = undefined
      break
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') { lastErr = undefined; break }
      lastErr = e
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') break
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
    }
  }
  const root = tmpRoot(cfg)
  try { if (!readdirSync(root).length) rmSync(root, { recursive: true, force: true }) } catch { /* not empty / in use / absent */ }
  if (lastErr) throw new Error(`工作目录清理失败：${work}：${(lastErr as Error).message}`)
}

/** Clean only paths owned by this job; never scan or delete another active job. */
export async function cleanupTemporaryFiles(paths: Iterable<string>): Promise<void> {
  const failed: string[] = []
  for (const path of paths) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { unlinkSync(path); break }
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOENT') break
        if (attempt < 4 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
          await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
          continue
        }
        failed.push(path)
        break
      }
    }
  }
  if (failed.length) throw new Error(`临时文件清理失败：${failed.join('、')}`)
}

/** Remove leftover RE/mux cache folders from older runs sitting next to the finished file. */
export function cleanupOutputCaches(dir: string): void {
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return }
  for (const name of names) {
    if (!name.startsWith('.re-') && !name.startsWith('.mux-timing-')) continue
    const path = join(dir, name)
    try {
      if (statSync(path).isDirectory()) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch { /* finished file already in place */ }
  }
  // Older builds put RE/decrypt scratch in `<outDir>/.gvs-tmp`; drop it once
  // the last job using it is gone.
  const tmp = join(dir, '.gvs-tmp')
  try {
    if (readdirSync(tmp).length === 0) rmSync(tmp, { recursive: true, force: true })
  } catch { /* still in use or absent */ }
}

async function playYouku(cli: GwClient, cfg: FileConfig, t: DlTask, vid = t.vid): Promise<Record<string, unknown>> {
  // RE/relay reads the selected playlist; expanding every track here fetches
  // unused playlists and adds latency to every signed-URL refresh.
  const input = youkuPlayInput(vid, t.quality)
  return cli.invoke('youku', 'play', input, cli.extra(cfg, 'youku'))
}


export function patchJob(jobs: Job[], e: JobEvt): void {
  const row = jobs.find((j) => j.id === e.id)
  if (!row) return
  if (e.status !== '失败' && e.status !== '重试') row.phase = e.status
  else row.phase ||= row.status
  row.status = e.status
  row.pct = e.pct
  row.log = e.log
  row.err = e.err
  if (e.done) {
    row.note = e.note ?? ''
    if (!e.err && !e.stopped) row.completedMedia = e.completedMedia
  } else row.completedMedia = undefined
}

/** mkv track name from the probed codec. Platform slogans stay off the file. */
export function muxTrackTitle(lang: string, probed: string): string {
  const language = lang.trim()
  if (!language || language === '原声' || language === '—' || language === '-') return probed
  return `${language} ${probed}`
}

/**
 * Quality probe runs once on the first selected episode. Audio rows therefore
 * carry that episode's `vid` / `vid|streamType` id. Batch downloads must rebind
 * each track onto the *current* episode (or its language sibling) so later
 * episodes do not mux episode-1 audio over episode-N video.
 */
export function bindYoukuAudioTracksToTask(
  tracks: NonNullable<DlTask['audioTracks']>,
  task: Pick<DlTask, 'vid' | 'languages'>,
): NonNullable<DlTask['audioTracks']> {
  return tracks.map((track) => {
    const streamType = youkuAudioStreamType(track.id)
    const byLang = (task.languages ?? []).find((l) => {
      if (!l.vid || !l.lang || !track.lang) return false
      return l.lang === track.lang || l.lang.includes(track.lang) || track.lang.includes(l.lang)
    })
    const targetVid = byLang?.vid || task.vid
    const langKey = youkuSpokenLangKey(track.lang)
    const id = streamType
      ? (langKey ? `${targetVid}|${streamType}|${langKey}` : `${targetVid}|${streamType}`)
      : targetVid
    return {
      ...track,
      id,
      vid: targetVid,
    }
  })
}

/** Vids that belong to this download task (primary + language editions). */
export function youkuTaskAudioVids(t: Pick<DlTask, 'vid' | 'languages'>): Set<string> {
  const out = new Set<string>()
  if (t.vid) out.add(t.vid)
  for (const l of t.languages ?? []) if (l.vid) out.add(l.vid)
  return out
}

/**
 * Resolve which Youku vid to play for an audio track. Never returns another
 * episode's probe vid: only this task's primary vid or its language siblings.
 */
export function trackVid(t: DlTask, trackId: string, explicit?: string): string {
  const allowed = youkuTaskAudioVids(t)
  if (explicit && allowed.has(explicit)) return explicit
  const sep = trackId.indexOf('|')
  const fromId = sep >= 0 ? trackId.slice(0, sep) : ''
  if (fromId && allowed.has(fromId)) return fromId
  return t.vid
}

/** Per-episode audio fetch plan used by dlYouku (and multi-ep isolation tests). */
export function youkuAudioFetchPlan(
  t: DlTask,
  tracks: Array<{ id: string; label: string; lang: string; vid?: string }>,
): Array<{ label: string; lang: string; streamType: string; audioVid: string; trackId: string }> {
  const bound = bindYoukuAudioTracksToTask(tracks, t)
  return bound.map((track) => ({
    label: track.label,
    lang: track.lang,
    streamType: youkuAudioStreamType(track.id),
    audioVid: trackVid(t, track.id, track.vid),
    trackId: track.id,
  }))
}

/** Media is fetched on this client; gateway traffic is limited to resolve calls. */
async function dlManifestProvider(cli: GwClient, cfg: FileConfig, t: DlTask, out: string, emit: (s: string, p: number, l: string) => void, work: string, signal?: AbortSignal): Promise<void> {
  const sources = await resolveManifest(cli, cfg, t.provider, t.vid, t.quality || 'auto')
  signal?.throwIfAborted()
  const source = sources[0]!
  requireClearDownload(source)
  const ref = source.headers.Referer || source.headers.referer || ''
  if (!['dash','hls'].includes(source.format.toLowerCase()) && !new URL(source.url).pathname.match(/[.](mpd|m3u8)$/i)) {
    throw new Error('该源不是已接入的 DASH/HLS 清单；拒绝伪装封装格式')
  }
  emit('下载', 0.05, '源站 CDN → 本机；网关不转发视频')
  await writeFinal(out, dest => downloadPlaylist({ src: source.url, dest, ref, headers: source.headers, threads: cfg.threads, select: 'muxed', muxTracks: true, transport: 're', workDir: work, workTag: 'manifest', signal, cb: (n,total,info) => { const p = total > 1 ? n / total : n; emit(playlistStatus('下载', info?.phase || 'download'), 0.05 + 0.9 * p, info?.log || '本机直连 CDN') } }))
}
