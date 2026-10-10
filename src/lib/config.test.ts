import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { chooseOutDir, defaultConfig, ensureOutDir, isLegacyDownloads, loadConfig, normalizeOutDir, saveConfig, type FileConfig } from './config.ts'
import { removeScratch, scratchDir, scratchDirIn } from './scratch.ts'

describe('download directory', () => {
  test('legacy relative default is recognized, an explicit folder is not', () => {
    expect(isLegacyDownloads('./downloads')).toBe(true)
    expect(isLegacyDownloads('.\\downloads\\')).toBe(true)
    expect(isLegacyDownloads('downloads')).toBe(true)
    expect(isLegacyDownloads('G:\\hongguo_handoff\\tui\\downloads')).toBe(false)
    expect(isLegacyDownloads('D:\\GVS')).toBe(false)
  })

  test('picks the largest fixed drive that is not the system drive', () => {
    const dir = chooseOutDir({
      platform: 'win32',
      home: 'C:\\Users\\a',
      systemDrive: 'C:',
      drives: [
        { root: 'C:\\', free: 100 },
        { root: 'D:\\', free: 50 },
        { root: 'G:\\', free: 800 },
      ],
    })
    expect(dir).toBe('G:\\GVS')
  })

  test('stays in Videos when every fixed drive is the system drive', () => {
    const dir = chooseOutDir({
      platform: 'win32',
      home: 'C:\\Users\\a',
      systemDrive: 'C:',
      drives: [{ root: 'C:\\', free: 100 }],
    })
    expect(dir).toBe(join('C:\\Users\\a', 'Videos', 'GVS'))
  })

  test('keeps a saved absolute directory and replaces only the legacy default', () => {
    const saved = join(tmpdir(), 'gvs-config-test', 'downloads')
    const fallback = join(tmpdir(), 'gvs-config-test', 'GVS')
    const kept = { outDir: saved }
    expect(ensureOutDir(kept, fallback)).toBe(false)
    expect(kept.outDir).toBe(saved)

    const legacy = { outDir: './downloads' }
    expect(ensureOutDir(legacy, fallback)).toBe(true)
    expect(legacy.outDir).toBe(fallback)
  })

  test('typed paths are stored absolute', () => {
    expect(normalizeOutDir('  D:\\Shows  ')).toBe(resolve('D:\\Shows'))
    expect(normalizeOutDir('   ')).toBe('')
  })

  test('tmpDir defaults to empty and is normalised like outDir', () => {
    expect(defaultConfig().tmpDir).toBe('')
    // '' keeps the default (outDir/.gvs-tmp); a typed path becomes absolute so
    // a later launch does not resolve it against the process cwd.
    expect(normalizeOutDir('')).toBe('')
    expect(normalizeOutDir('  E:\gvs-cache  ')).toBe(resolve('E:\gvs-cache'))
  })

  test('an old config without tmpDir still loads and gains the field', () => {
    // Redirect APPDATA so the real user config is never touched.
    const appdata = mkdtempSync(join(tmpdir(), 'gvs-appdata-'))
    const previous = process.env.APPDATA
    process.env.APPDATA = appdata
    try {
      const file = join(appdata, 'gvs', 'tui.json')
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ outDir: 'D:\GVS', threads: 8, hongguoFmt: 'mp4' }))
      const cfg = loadConfig()
      expect(cfg.tmpDir).toBe('')
      expect(cfg.threads).toBe(8)
      expect(cfg.hongguoFmt).toBe('mp4')
      // The field is persisted, and a relative tmpDir becomes absolute.
      saveConfig({ ...cfg, tmpDir: 'E:\gvs-cache' } as FileConfig)
      expect(JSON.parse(readFileSync(file, 'utf8')).tmpDir).toBe('E:\gvs-cache')
      expect(loadConfig().tmpDir).toBe(resolve('E:\gvs-cache'))
    } finally {
      if (previous === undefined) delete process.env.APPDATA
      else process.env.APPDATA = previous
      rmSync(appdata, { recursive: true, force: true })
    }
  })

  test('scratchDirIn uses the requested folder and only falls back when it fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'gvs-scratch-in-'))
    try {
      const notes: string[] = []
      const made = scratchDirIn(root, 're-', (m) => notes.push(m))
      expect(made.startsWith(root)).toBe(true)
      expect(notes).toEqual([])
      // removeScratch also drops the now-empty parent, like the .gvs-tmp case.
      removeScratch(made)
      expect(existsSync(made)).toBe(false)
      mkdirSync(root, { recursive: true })
      // A file where the folder should be makes creation fail; the fallback is
      // reported instead of silently landing on the system drive.
      const blocked = join(root, 'blocked')
      writeFileSync(blocked, 'x')
      const fallback = scratchDirIn(join(blocked, 'nested'), 're-', (m) => notes.push(m))
      expect(notes).toHaveLength(1)
      expect(fallback.startsWith(tmpdir())).toBe(true)
      rmSync(fallback, { recursive: true, force: true })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('scratch files sit next to the output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gvs-scratch-anchor-'))
    try {
      const scratch = scratchDir(join(dir, 'episode.mkv'), 'gvs-re-')
      expect(scratch.startsWith(join(dir, '.gvs-tmp'))).toBe(true)
      removeScratch(scratch)
      expect(existsSync(join(dir, '.gvs-tmp'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('desktop proxy defaults to system routing and persists independently of TUI proxy settings', () => {
  const appdata = mkdtempSync(join(tmpdir(), 'gvs-desktop-proxy-'))
  const previous = process.env.APPDATA
  process.env.APPDATA = appdata
  try {
    expect(defaultConfig().desktopProxy).toBe('')
    const file = join(appdata, 'gvs', 'tui.json')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ outDir: join(appdata, 'library'), gatewayProxy: 'http://localhost:7897', tmdbProxy: 'http://localhost:7898' }))
    const old = loadConfig()
    expect(old.desktopProxy).toBe('')
    saveConfig({ ...old, desktopProxy: 'http://127.0.0.1:8899' })
    const restored = loadConfig()
    expect(restored.desktopProxy).toBe('http://127.0.0.1:8899')
    expect(restored.gatewayProxy).toBe('http://localhost:7897')
    expect(restored.tmdbProxy).toBe('http://localhost:7898')
    saveConfig({ ...restored, desktopProxy: '' })
    expect(loadConfig().desktopProxy).toBe('')
  } finally {
    if (previous === undefined) delete process.env.APPDATA
    else process.env.APPDATA = previous
    rmSync(appdata, { recursive: true, force: true })
  }
})

test('episode-title naming defaults on in old configs and persists an explicit off/on choice', () => {
  const appdata = mkdtempSync(join(tmpdir(), 'gvs-name-setting-'))
  const previous = process.env.APPDATA
  process.env.APPDATA = appdata
  try {
    expect(defaultConfig().includeEpisodeTitle).toBe(true)
    const file = join(appdata, 'gvs', 'tui.json')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ outDir: join(appdata, 'library') }))
    const cfg = loadConfig()
    expect(cfg.includeEpisodeTitle).toBe(true)
    saveConfig({ ...cfg, includeEpisodeTitle: false })
    expect(JSON.parse(readFileSync(file, 'utf8')).includeEpisodeTitle).toBe(false)
    expect(loadConfig().includeEpisodeTitle).toBe(false)
    saveConfig({ ...cfg, includeEpisodeTitle: true })
    expect(loadConfig().includeEpisodeTitle).toBe(true)
  } finally {
    if (previous === undefined) delete process.env.APPDATA
    else process.env.APPDATA = previous
    rmSync(appdata, { recursive: true, force: true })
  }
})
