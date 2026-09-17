import { expect, test } from 'bun:test'
import { cleanRELog, hlsKeyArgs, reProgress, reHttpFailureMonitor, runM3u8dl, CdnDenied } from './media.ts'

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

test('the first CDN denial triggers refresh, including a split log line', () => {
  const monitor = reHttpFailureMonitor()
  const line = 'WARN: Response status code does not indicate success: 403 (Forbidden).\n'
  expect(monitor.feed('INFO: loading https://cdn.test/403/segment\n')).toBe(0)
  expect(monitor.feed(line)).toBe(403)
  expect(monitor.feed('WARN: HTTP 4')).toBe(0)
  expect(monitor.feed('10 Gone\n')).toBe(410)
})

test('a running downloader is terminated promptly on the first 403 instead of hanging', async () => {
  const script = `console.log('WARN: HTTP 403 Forbidden'); setInterval(() => {}, 1000)`
  await expect(runM3u8dl(process.execPath, ['-e', script], '')).rejects.toBeInstanceOf(CdnDenied)
}, 5000)
