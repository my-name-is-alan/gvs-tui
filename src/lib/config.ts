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
  tencentCookie: string
  hongguoMerge: boolean
  hongguoNfo: boolean
  hongguoFmt: string
  ffmpeg: string
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
    ffmpeg: 'ffmpeg',
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
  cfg.host = (cfg.host || 'http://127.0.0.1:8080').replace(/\/+$/, '')
  if (!cfg.outDir) cfg.outDir = join('.', 'downloads')
  if (!cfg.releaseGroup) cfg.releaseGroup = 'ADWeb'
  if (!cfg.hongguoFmt) cfg.hongguoFmt = 'mkv'
  if (!cfg.ffmpeg) cfg.ffmpeg = 'ffmpeg'
  if (!cfg.tmdbLang) cfg.tmdbLang = 'zh-CN'
  return cfg
}

export function saveConfig(cfg: FileConfig): void {
  const p = configPath()
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 })
}
