import { afterAll, expect, test } from 'bun:test'
import { GwClient } from './client.ts'
import { defaultConfig } from './config.ts'

const seen: Record<string, string | null> = {}
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { provider: string }
    seen[body.provider] = req.headers.get('Dy-Cookie')
    return Response.json({ code: 0, msg: 'ok', data: {} })
  },
})
afterAll(() => server.stop(true))

test('douyin invokes carry the saved Dy-Cookie; other providers do not', async () => {
  const cfg = { ...defaultConfig(), douyinCookie: 'sessionid=abc' }
  const cli = new GwClient(`http://127.0.0.1:${server.port}`, 'k', () => cfg)
  await cli.invoke('douyin', 'search', { q: 'x' })
  await cli.invoke('hongguo', 'search', { q: 'x' })
  expect(seen.douyin).toBe('sessionid=abc')
  expect(seen.hongguo).toBeNull()
})
