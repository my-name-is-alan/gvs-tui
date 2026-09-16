import { describe, expect, test } from 'bun:test'
import { qrNeedsAscii, renderQr } from './youku-qr.ts'

const URL = 'https://passport.youku.com/qr?token=test'

describe('qrNeedsAscii', () => {
  test('Windows conhost / PowerShell 5 without WT uses ASCII', () => {
    expect(qrNeedsAscii({}, 'win32')).toBe(true)
  })

  test('Windows Terminal and VS Code keep compact blocks', () => {
    expect(qrNeedsAscii({ WT_SESSION: '1' }, 'win32')).toBe(false)
    expect(qrNeedsAscii({ TERM_PROGRAM: 'vscode' }, 'win32')).toBe(false)
    expect(qrNeedsAscii({ ConEmuANSI: 'ON' }, 'win32')).toBe(false)
  })

  test('non-Windows keeps compact blocks', () => {
    expect(qrNeedsAscii({}, 'linux')).toBe(false)
    expect(qrNeedsAscii({}, 'darwin')).toBe(false)
  })
})

describe('renderQr', () => {
  test('ascii is only hash and space so GBK PowerShell can print it', () => {
    const text = renderQr(URL, 'ascii')
    expect(text.length).toBeGreaterThan(0)
    expect(text).toMatch(/^[ #\n]+$/)
    const lines = text.split('\n')
    const width = lines[0].length
    expect(lines.every((l) => l.length === width)).toBe(true)
    // quiet zone + 7-module finder: '  ' then 14 '#'
    expect(lines[1].startsWith('  ##############')).toBe(true)
  })

  test('compact packs two rows with half-blocks', () => {
    const text = renderQr(URL, 'compact')
    expect(/[█▀▄]/.test(text)).toBe(true)
    expect(text.includes('#')).toBe(false)
    const ascii = renderQr(URL, 'ascii')
    expect(text.split('\n').length).toBeLessThan(ascii.split('\n').length)
  })
})
