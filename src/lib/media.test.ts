import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanRELog, hlsExtinfSeconds, hlsKeyArgs, reProgress, reHttpFailureMonitor, runM3u8dl, CdnDenied } from './media.ts'

test('CENC key is also supplied to the HLS parser, skipping the key URI fetch', () => {
  const key = '0123456789abcdef0123456789abcdef'
  expect(hlsKeyArgs(`${'a'.repeat(32)}:${key}`)).toEqual([
    '--key', `${'a'.repeat(32)}:${key}`, '--custom-hls-key', key, '--custom-hls-method', 'CENC',
  ])
  expect(() => hlsKeyArgs('invalid')).toThrow('密钥格式')
  expect(hlsKeyArgs()).toEqual([])
})

test('pipe progress handles partial tokens, multiple redraws and never reports completion early', () => {
  const values: number[] = []
  const feed = reProgress((n) => values.push(n))
  feed('Vid ━━ 1/8 \x1b[32m12.')
  feed('5%\x1b[0m\rVid ━━ 2/10 20%\rVid ━━ 18/100 18%\r')
  feed('Vid ━━ 8/8 100%')
  expect(values).toEqual([0.125, 0.2, 0.99])
})

test('signed URL escapes and unrelated phase percentages never advance download progress', () => {
  const values: number[] = []
  const feed = reProgress((n) => values.push(n))
  feed('INFO: URL https://cdn.test/m3u8?vid=0788%')
  feed('3D%3D&token=12345%257C\nParsing 100%\nDecrypt 100%\n')
  expect(values).toEqual([])
  feed('Vid ━━ 1/325 0.31% 5 MiB/s\n')
  expect(values).toEqual([1 / 325])
})

test('redirection notice is not presented as the error; URLs are redacted', () => {
  expect(cleanRELog('INFO: 输出被重定向\nINFO: Output is redirected.\nERROR: HTTP 403 https://cdn.test/a?token=secret'))
    .toBe('ERROR: HTTP 403 [媒体地址]')
})

test('CDN status detection handles split log lines', () => {
  const monitor = reHttpFailureMonitor()
  const line = 'WARN: Response status code does not indicate success: 403 (Forbidden).\n'
  expect(monitor.feed('INFO: loading https://cdn.test/403/segment\n')).toBe(0)
  expect(monitor.feed(line)).toBe(403)
  expect(monitor.feed('WARN: HTTP 4')).toBe(0)
  expect(monitor.feed('10 Gone\n')).toBe(410)
})

test('a downloader can recover from 403 without being killed', async () => {
  const script = `console.log('WARN: HTTP 403 Forbidden'); setTimeout(() => console.log('INFO: Done'), 350)`
  const result = await runM3u8dl(process.execPath, ['-e', script], '')
  expect(result).toContain('Done')
}, 5000)

test('a failed exit with CDN denial and no final newline triggers URL refresh', async () => {
  await expect(runM3u8dl(process.execPath, ['-e', `process.stdout.write('WARN: HTTP 403 Forbidden'); process.exitCode=1`], '')).rejects.toBeInstanceOf(CdnDenied)
})

test('a successful exit is not rejected for recovered CDN warnings in the log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-re-log-'))
  try {
    const log = join(dir, 're.log')
    writeFileSync(log, 'ERROR: Response status code does not indicate success: 410 (Gone).')
    await expect(runM3u8dl(process.execPath, ['-e', `console.log('INFO: Done')`], log)).resolves.toContain('Done')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('stop only once RE explicitly exhausts its own retries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-re-log-'))
  try {
    const log = join(dir, 're.log')
    writeFileSync(log, 'WARN: HTTP 403 Forbidden\nThe retry attempts have been exhausted and the download of this segment has failed.')
    await expect(runM3u8dl(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], log)).rejects.toBeInstanceOf(CdnDenied)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 5000)

test('successful exit preserves file diagnostics and redacts keys and media URLs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-re-log-'))
  try {
    const log = join(dir, 're.log'), key = '0123456789abcdef0123456789abcdef'
    writeFileSync(log, `ERROR: decrypt failed; key=${key}; source=https://cdn.test/file?secret=token`)
    const info = await runM3u8dl(process.execPath, ['-e', `console.log('Output is redirected.')`], log)
    expect(info).toContain('decrypt failed')
    expect(info).not.toContain(key)
    expect(info).not.toContain('secret=token')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('EXTINF list ignores key and placement tags', () => {
  const infs = hlsExtinfSeconds('#EXTM3U\n#EXTINF:7.983333,\nseg1\n#EXT-X-PLACEMENT-OPPORTUNITY\n#EXTINF:11.333333,\nseg2\n#EXT-X-KEY:METHOD=CENC\n#EXTINF:9.633333,\nseg3\n')
  expect(infs).toEqual([7.983333, 11.333333, 9.633333])
})

test('RE explicit final failure is rejected even when the process exits zero', async () => {
  const script = `console.log('WARN: Download speed too slow!'); console.log('ERROR: Segment count check not pass'); console.log('ERROR: Failed')`
  await expect(runM3u8dl(process.execPath, ['-e', script], '')).rejects.toThrow('Download speed too slow')
})
