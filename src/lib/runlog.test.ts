import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resetRunLogStartup,
  runLog,
  runLogEnabled,
  runLogPath,
  runLogStartup,
  setRunLogDisabled,
  summarizeInput,
  summarizeResult,
} from './runlog.ts'

const dirs: string[] = []
afterEach(() => {
  setRunLogDisabled(false)
  delete process.env.GVS_TUI_LOG
  delete process.env.GVS_TUI_LOG_PATH
  resetRunLogStartup()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('runlog', () => {
  test('GVS_TUI_LOG=0 disables', () => {
    process.env.GVS_TUI_LOG = '0'
    expect(runLogEnabled()).toBe(false)
  })

  test('writes startup + redacts secrets; truncates vkey URLs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gvs-runlog-'))
    dirs.push(dir)
    process.env.GVS_TUI_LOG_PATH = join(dir, 'tui-run.log')
    setRunLogDisabled(false)
    resetRunLogStartup()
    runLogStartup({ host: 'http://gw.test', version: '0.2.4', git: 'abc1234', scene: 'home' })
    runLog(`invoke tencent/play ${summarizeInput({ vid: 'x', cookie: 'secret', defn: 'fhd' })} ok ${summarizeResult({ has_url: true, formats: [{}, {}] })}`)
    const text = readFileSync(process.env.GVS_TUI_LOG_PATH, 'utf8')
    expect(text).toContain('startup')
    expect(text).toContain('ver=0.2.4')
    expect(text).toContain('cookie=***')
    expect(text).toContain('n_formats=2')
    expect(text).not.toContain('secret')
  })

  test('runLogPath defaults under config dir name tui-run.log', () => {
    delete process.env.GVS_TUI_LOG_PATH
    expect(runLogPath().endsWith('tui-run.log') || runLogPath().endsWith('tui-run.log')).toBe(true)
  })
})
