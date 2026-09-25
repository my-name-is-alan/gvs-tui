import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chooseOutDir, ensureOutDir, isLegacyDownloads, normalizeOutDir } from './config.ts'
import { removeScratch, scratchDir } from './scratch.ts'

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
    const kept = { outDir: 'G:\\hongguo_handoff\\tui\\downloads' }
    expect(ensureOutDir(kept, 'D:\\GVS')).toBe(false)
    expect(kept.outDir).toBe('G:\\hongguo_handoff\\tui\\downloads')

    const legacy = { outDir: './downloads' }
    expect(ensureOutDir(legacy, 'G:\\GVS')).toBe(true)
    expect(legacy.outDir).toBe('G:\\GVS')
  })

  test('typed paths are stored absolute', () => {
    expect(normalizeOutDir('  D:\\Shows  ')).toBe(resolve('D:\\Shows'))
    expect(normalizeOutDir('   ')).toBe('')
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
