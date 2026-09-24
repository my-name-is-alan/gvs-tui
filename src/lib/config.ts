import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

export type FileConfig = {
  host: string
  key: string
  outDir: string
  releaseGroup: string
  tmdbKey: string
  tmdbLang: string
  youkuSign: string
  tencentMode?: "cookie" | "web" | "app" | "tv"
  tencentTVDevice?: string
  tencentTVQUA?: string
  tencentTVVersion?: string
  tencentCookie: string
  /** 抖音网页登录 Cookie（含 sessionid），搜索需要；随请求以 Dy-Cookie 头发给网关 */
  douyinCookie?: string
  /** Opt-in: probe play with encode=all (风控敏感，默认关) */
  tencentEncodeAll?: boolean
  /** Opt-in: catalog probe with source=1 / 原画 (默认关，易触发权益锁) */
  tencentProbeSource?: boolean
  /** Opt-in: catalog probe with caption=all (默认关；默认只探 soft) */
  tencentCaptionAll?: boolean
  hongguoMerge: boolean
  hongguoNfo: boolean
  hongguoFmt: string
  /** 黄果（HLS + AES-128）输出：是否写 NFO、封装容器。 */
  huangguoNfo: boolean
  huangguoFmt: string
  /** Parallel connections per download (分片并发 / Range 并发). */
  threads: number
}

export const MIN_THREADS = 1
export const MAX_THREADS = 16

export function clampThreads(n: unknown): number {
  const v = Math.trunc(Number(n))
  if (!Number.isFinite(v) || v <= 0) return 4
  return Math.min(MAX_THREADS, Math.max(MIN_THREADS, v))
}

export function defaultConfig(): FileConfig {
  return {
    host: 'http://127.0.0.1:8080',
    key: '',
    outDir: join('.', 'downloads'),
    releaseGroup: 'ADWeb',
    tmdbKey: '',
    tmdbLang: 'zh-CN',
    youkuSign: '',
    tencentCookie: '',
    hongguoMerge: true,
    hongguoNfo: true,
    hongguoFmt: 'mkv',
    huangguoNfo: true,
    huangguoFmt: 'mkv',
    threads: 4,
  }
}

export function configPath(): string {
  const base = process.env.APPDATA || process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'gvs', 'tui.json')
}

export function loadConfig(): FileConfig {
  const cfg = defaultConfig()
  try {
    Object.assign(cfg, JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<FileConfig>)
  } catch {
    // first run
  }
  // Point a single run somewhere else without touching the saved config, e.g.
  // `GVS_HOST=http://127.0.0.1:8080 bun run dev` against a local gateway build.
  if (process.env.GVS_HOST) cfg.host = process.env.GVS_HOST
  if (process.env.GVS_KEY) cfg.key = process.env.GVS_KEY
  cfg.host = (cfg.host || 'http://127.0.0.1:8080').replace(/\/+$/, '')
  if (!cfg.outDir) cfg.outDir = join('.', 'downloads')
  if (!cfg.releaseGroup) cfg.releaseGroup = 'ADWeb'
  if (!cfg.hongguoFmt) cfg.hongguoFmt = 'mkv'
  if (!cfg.huangguoFmt) cfg.huangguoFmt = 'mkv'
  delete (cfg as unknown as Record<string, unknown>).ffmpeg
  if (!cfg.tmdbLang) cfg.tmdbLang = 'zh-CN'
  cfg.threads = clampThreads(cfg.threads)
  return cfg
}

export function saveConfig(cfg: FileConfig): void {
  const p = configPath()
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 })
}
