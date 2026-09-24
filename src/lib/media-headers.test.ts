import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadProgress, headersFor } from './media.ts'

test('gateway headers override defaults case-insensitively while resume controls Range', () => {
  const headers = new Headers(headersFor('https://fallback.test/', 100, {
    'user-agent': 'Gateway-UA', referer: 'https://selected.test/', range: 'bytes=0-1',
  }))
  expect(headers.get('user-agent')).toBe('Gateway-UA')
  expect(headers.get('referer')).toBe('https://selected.test/')
  expect(headers.get('range')).toBe('bytes=100-')
})

for (const threads of [1, 2]) {
  test(`gateway headers reach every CDN request with ${threads} download threads`, async () => {
    const payload = Buffer.alloc(threads === 1 ? 1024 : 5 << 20, 0x47)
    const requests: Headers[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch(req) {
        requests.push(req.headers)
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get('range') || '')
        if (range) {
          const start = Number(range[1]), end = range[2] ? Number(range[2]) : payload.length - 1
          return new Response(payload.subarray(start, end + 1), {
            status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${payload.length}` },
          })
        }
        return new Response(payload)
      },
    })
    const dir = mkdtempSync(join(tmpdir(), 'gvs-headers-'))
    try {
      const dest = join(dir, 'video.mp4')
      await downloadProgress(`http://127.0.0.1:${server.port}/video.mp4`, dest,
        'https://fallback.test/', undefined, undefined, threads, undefined,
        { 'User-Agent': 'Gateway-UA', Referer: 'https://selected.test/', 'X-Media': 'selected' })
      expect(readFileSync(dest).equals(payload)).toBe(true)
      expect(requests.length).toBeGreaterThanOrEqual(threads)
      for (const headers of requests) {
        expect(headers.get('user-agent')).toBe('Gateway-UA')
        expect(headers.get('referer')).toBe('https://selected.test/')
        expect(headers.get('x-media')).toBe('selected')
      }
    } finally {
      server.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
