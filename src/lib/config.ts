import { execFileSync } from 'node:child_process'
import { statfsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
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

export type DriveFree = { root: string; free: number }

/** Untouched historical default. Relative to the process cwd, so an installed app writes onto C:. */
export function isLegacyDownloads(p: string): boolean {
  const n = p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return n === 'downloads' || n === './downloads'
}

/**
 * Prefer the fixed drive with the most free space that is not the system drive.
 * Falls back to the user's Videos folder when that is the only disk.
 */
export function chooseOutDir(opts: {
  platform: string
  home: string
  systemDrive: string
  drives: DriveFree[]
}): string {
  if (opts.platform === 'win32') {
    const sys = opts.systemDrive.replace(/[\\/]+$/, '').toUpperCase()
    const best = opts.drives
      .filter((d) => d.free > 0 && d.root.replace(/[\\/]+$/, '').toUpperCase() !== sys)
      .sort((a, b) => b.free - a.free)[0]
    if (best) return `${best.root.replace(/[\\/]+$/, '')}\\GVS`
  }
  return join(opts.home, 'Videos', 'GVS')
}

function windowsFixedDrives(): DriveFree[] {
  try {
    const text = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { $_.DeviceID + "|" + [int64]$_.FreeSpace }',
      ],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    )
    const drives = text.split(/\r?\n/).flatMap((line) => {
      const [id, free] = line.trim().split('|')
      if (!id || !/^[A-Za-z]:$/.test(id)) return []
      return [{ root: `${id}\\`, free: Number(free) || 0 }]
    })
    if (drives.length) return drives
  } catch {
    // statfs fallback below
  }
  const found: DriveFree[] = []
  for (let i = 65; i <= 90; i++) {
    const root = `${String.fromCharCode(i)}:\\`
    try {
      const s = statfsSync(root)
      const free = Number(s.bavail) * Number(s.bsize)
      if (free > 0) found.push({ root, free })
    } catch {
      // drive letter is empty
    }
  }
  return found
}

let cachedOutDir: string | undefined

/** Absolute default library folder. Cached for the process. */
export function preferredOutDir(): string {
  if (cachedOutDir) return cachedOutDir
  const home = homedir()
  if (process.platform !== 'win32') {
    cachedOutDir = join(home, 'Videos', 'GVS')
    return cachedOutDir
  }
  cachedOutDir = chooseOutDir({
    platform: 'win32',
    home,
    systemDrive: process.env.SystemDrive || 'C:',
    drives: windowsFixedDrives(),
  })
  return cachedOutDir
}

/** Store an absolute directory. Empty input stays empty so the caller can reject it. */
export function normalizeOutDir(input: string): string {
  const v = input.trim()
  return v ? resolve(v) : ''
}

/**
 * Fill a missing or legacy `./downloads` with the preferred absolute folder.
 * A relative path the user typed is resolved once so later launches do not follow cwd back onto C:.
 * Returns whether `outDir` changed.
 */
export function ensureOutDir(cfg: { outDir: string }, fallback?: string): boolean {
  const cur = (cfg.outDir || '').trim()
  if (cur && !isLegacyDownloads(cur)) {
    if (!isAbsolute(cur)) {
      cfg.outDir = resolve(cur)
      return cfg.outDir !== cur
    }
    if (cfg.outDir !== cur) {
      cfg.outDir = cur
      return true
    }
    return false
  }
  cfg.outDir = fallback ?? preferredOutDir()
  return true
}

export function defaultConfig(): FileConfig {
  return {
    host: 'http://127.0.0.1:8080',
    key: '',
    outDir: '',
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
  let existed = true
  try {
    Object.assign(cfg, JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<FileConfig>)
  } catch {
    existed = false
  }
  // Point a single run somewhere else without touching the saved config, e.g.
  // `GVS_HOST=http://127.0.0.1:8080 bun run dev` against a local gateway build.
  if (process.env.GVS_HOST) cfg.host = process.env.GVS_HOST
  if (process.env.GVS_KEY) cfg.key = process.env.GVS_KEY
  cfg.host = (cfg.host || 'http://127.0.0.1:8080').replace(/\/+$/, '')
  const outChanged = ensureOutDir(cfg)
  if (!cfg.releaseGroup) cfg.releaseGroup = 'ADWeb'
  if (!cfg.hongguoFmt) cfg.hongguoFmt = 'mkv'
  if (!cfg.huangguoFmt) cfg.huangguoFmt = 'mkv'
  delete (cfg as unknown as Record<string, unknown>).ffmpeg
  if (!cfg.tmdbLang) cfg.tmdbLang = 'zh-CN'
  cfg.threads = clampThreads(cfg.threads)
  // Remember the resolved folder. An existing absolute outDir is left untouched.
  if (outChanged && existed) {
    try { saveConfig(cfg) } catch { /* keep the in-memory path */ }
  }
  return cfg
}

export function saveConfig(cfg: FileConfig): void {
  const p = configPath()
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 })
}
