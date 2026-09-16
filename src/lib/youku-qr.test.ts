import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { pollYoukuQR, qrAscii, writeQrPng } from './youku-qr.ts'

const URL = 'https://passport.youku.com/qr?token=test'

describe('qrAscii', () => {
  test('keeps utf8 half-blocks for the terminal', async () => {
    const text = await qrAscii(URL)
    expect(/[█▀▄]/.test(text)).toBe(true)
    expect(text.includes('#')).toBe(false)
  })
})

describe('writeQrPng', () => {
  test('writes a PNG the user can scan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gvs-qr-'))
    try {
      const file = await writeQrPng(URL, join(dir, 'youku-qr', 'youku_qr_login.png'))
      expect(file.endsWith('youku_qr_login.png')).toBe(true)
      const buf = readFileSync(file)
      expect(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('pollYoukuQR', () => {
  test('sends ticket and loginToken on check', async () => {
    let input: Record<string, unknown> | undefined
    const cli = {
      invoke: async (_provider: string, _action: string, body: Record<string, unknown>) => {
        input = body
        return { pending: true, logged_in: false }
      },
    }
    await pollYoukuQR(cli as never, 'ticket-1', 'token-1')
    expect(input).toEqual({ method: 'qr', state: 'check', yk_ticket: 'ticket-1', loginToken: 'token-1' })
  })
})
