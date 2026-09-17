import { expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { createHlsRelay, HlsRefreshError, hlsAbsoluteUrl, hlsContentPath, rewriteHls } from './hls-relay.ts'
import { ReloginRequired } from './client.ts'

test('Youku refresh may rotate only the signed directory, not the content id', () => {
  const a = 'https://zreal.cp12.wasu.tv/' + 'a'.repeat(24) + '/asset_video_001.mp4?s=old'
  const b = 'https://zreal.cp12.wasu.tv/' + 'b'.repeat(24) + '/asset_video_001.mp4?s=new'
  expect(hlsContentPath(a)).toBe(hlsContentPath(b))
  expect(hlsContentPath(a)).toBe(hlsContentPath(b.replace('b'.repeat(24), 'c'.repeat(25))))
  expect(hlsContentPath(a)).not.toBe(hlsContentPath(b.replace('001', '002')))
  expect(hlsContentPath(a)).not.toBe(hlsContentPath(b.replace('asset_', 'other_')))
  expect(hlsContentPath(a.replace('zreal.cp12.wasu.tv', 'example.com'))).not.toBe(hlsContentPath(b.replace('zreal.cp12.wasu.tv', 'example.com')))
})

test('rewrite preserves signatures, byte ranges, init/key and nested playlists', () => {
  const found: Array<{ url: string; playlist: boolean }> = []
  const output = rewriteHls('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/list.m3u8"\n#EXT-X-MAP:URI="init.mp4?x=a%2Fb+z"\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-BYTERANGE:3@2\n#EXTINF:1,\nhttps://cdn.test/a%2Fb.mp4?x=a%2Fb+z\n#EXT-X-STREAM-INF:BANDWIDTH=100\nvideo.m3u8\n', 'https://cdn.test/root/master.m3u8', r => {
    found.push(r); return `http://localhost/${found.length}`
  })
  expect(found).toEqual([
    { url: 'https://cdn.test/root/audio/list.m3u8', playlist: true },
    { url: 'https://cdn.test/root/init.mp4?x=a%2Fb+z', playlist: false },
    { url: 'https://cdn.test/root/key.bin', playlist: false },
    { url: 'https://cdn.test/a%2Fb.mp4?x=a%2Fb+z', playlist: false },
    { url: 'https://cdn.test/root/video.m3u8', playlist: true },
  ])
  expect(output).toContain('#EXT-X-BYTERANGE:3@2')
  expect(rewriteHls('#EXTM3U\n#EXT-X-KEY:METHOD=CENC,URI="secret"', 'https://cdn.test/a', () => { throw new Error('clear key must not be fetched') }, true)).not.toContain('EXT-X-KEY')
  expect(() => hlsAbsoluteUrl('file:///secret', 'https://cdn.test/')).toThrow()
})

test('relay uses JS headers, redirect base, exact bytes/ranges and propagates 403', async () => {
  const requests: Array<{ url?: string; ua?: string; ref?: string; range?: string }> = []
  const origin = createServer((req, res) => {
    requests.push({ url: req.url, ua: req.headers['user-agent'], ref: req.headers.referer, range: req.headers.range })
    if (req.url === '/entry') { res.writeHead(302, { Location: '/folder/media.m3u8' }).end(); return }
    if (req.url === '/folder/media.m3u8') {
      res.end('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nseg.mp4?token=a%2Fb%2Bz%3D&space=a+b\n#EXTINF:1,\ndenied.mp4\n#EXT-X-ENDLIST\n'); return
    }
    if (req.url === '/folder/denied.mp4') { res.writeHead(403).end('denied'); return }
    if (req.url === '/folder/init.mp4') { res.end(Buffer.from([0, 1, 2, 3])); return }
    if (req.headers.range === 'bytes=2-4') { res.writeHead(206, { 'Content-Range': 'bytes 2-4/6', 'Content-Length': '3' }).end('cde'); return }
    res.end('abcdef')
  })
  await new Promise<void>(r => origin.listen(0, '127.0.0.1', r))
  const address = origin.address() as { port: number }
  const relay = await createHlsRelay(`http://127.0.0.1:${address.port}/entry`, { 'User-Agent': 'node-original', Referer: 'https://www.youku.com/' }, false, { wait: async () => {} })
  try {
    const playlist = await (await fetch(relay.url)).text()
    expect(playlist).not.toContain('token=')
    const init = /URI="([^"]+)"/.exec(playlist)![1]!
    expect(new Uint8Array(await (await fetch(init)).arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3]))
    const media = playlist.split('\n').filter(l => l && !l.startsWith('#'))
    const ranged = await fetch(media[0]!, { headers: { Range: 'bytes=2-4' } })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe('bytes 2-4/6')
    expect(await ranged.text()).toBe('cde')
    const denied = await fetch(media[1]!)
    expect(denied.status).toBe(403)
    await denied.text()
    expect((await fetch(relay.url.replace(/\/[^/]+\/[^/]+$/, '/unknown/resource'))).status).toBe(404)
    expect(requests.every(r => r.ua === 'node-original' && r.ref === 'https://www.youku.com/')).toBe(true)
    expect(requests.find(r => r.range)?.url).toBe('/folder/seg.mp4?token=a%2Fb%2Bz%3D&space=a+b')
  } finally {
    await relay.close()
    origin.closeAllConnections()
    await new Promise<void>(r => origin.close(() => r()))
  }
})

test('a transient CDN 403 is retried before RE sees it; persistent denial is bounded', async () => {
  const attempts: Record<string, number> = {}
  const origin = createServer((req, res) => {
    const path = req.url ?? ''
    attempts[path] = (attempts[path] ?? 0) + 1
    if (path === '/list.m3u8') { res.end('#EXTM3U\n#EXTINF:1,\nrecover.bin\n#EXTINF:1,\ndenied.bin\n'); return }
    if (path === '/denied.bin' || attempts[path]! < 3) { res.writeHead(403).end('temporary'); return }
    res.end('exact segment bytes')
  })
  await new Promise<void>(r => origin.listen(0, '127.0.0.1', r))
  const address = origin.address() as { port: number }
  const waits: number[] = [], statuses: number[] = []
  const relay = await createHlsRelay(`http://127.0.0.1:${address.port}/list.m3u8`, {}, false,
    { wait: async ms => { waits.push(ms) }, onResponse: e => { statuses.push(e.status) } })
  try {
    const urls = (await (await fetch(relay.url)).text()).split('\n').filter(l => l && !l.startsWith('#'))
    const recovered = await fetch(urls[0]!)
    expect(recovered.status).toBe(200)
    expect(await recovered.text()).toBe('exact segment bytes')
    expect(attempts['/recover.bin']).toBe(3)
    expect(waits).toEqual([500, 1000])
    const denied = await fetch(urls[1]!)
    expect(denied.status).toBe(403)
    await denied.text()
    expect(attempts['/denied.bin']).toBe(5)
    expect(waits.slice(2)).toEqual([500, 1000, 2000, 4000])
    expect(statuses).toEqual([200, 403, 403, 200, 403, 403, 403, 403, 403])
  } finally {
    await relay.close(); origin.closeAllConnections()
    await new Promise<void>(r => origin.close(() => r()))
  }
})

test('403 refreshes signed URLs in place, shares concurrent refreshes, and keeps completed fragments', async () => {
  let refreshes = 0
  const waits: number[] = []
  const hits: string[] = []
  const origin = createServer((req, res) => {
    const u = new URL(req.url!, 'http://localhost')
    hits.push(req.url!)
    if (u.pathname === '/media.m3u8') {
      const version = u.searchParams.get('v') ?? '0'
      res.end(`#EXTM3U\n#EXT-X-MAP:URI="init.mp4?v=${version}"\n#EXTINF:1,\na.mp4?v=${version}\n#EXTINF:1,\nb.mp4?v=${version}\n#EXTINF:1,\nc.mp4?v=${version}\n#EXT-X-ENDLIST\n`)
      return
    }
    if ((u.pathname === '/b.mp4' || u.pathname === '/c.mp4') && u.searchParams.get('v') === '0') {
      setTimeout(() => res.writeHead(403).end('expired'), 5)
      return
    }
    res.end(u.pathname)
  })
  await new Promise<void>(r => origin.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(origin.address() as { port: number }).port}`
  const relay = await createHlsRelay(`${base}/media.m3u8?v=0`, {}, false, {
    maxAttempts: 1, wait: async ms => { waits.push(ms) }, refreshSource: async () => {
      refreshes++
      await new Promise(r => setTimeout(r, 30))
      return `${base}/media.m3u8?v=1`
    },
  })
  try {
    const initial = await (await fetch(relay.url)).text()
    const urls = initial.split('\n').filter(l => l && !l.startsWith('#'))
    expect(await (await fetch(urls[0]!)).text()).toBe('/a.mp4')
    const responses = await Promise.all(urls.slice(1).map(async url => { const r = await fetch(url); return [r.status, await r.text()] }))
    expect(responses).toEqual([[200, '/b.mp4'], [200, '/c.mp4']])
    expect(refreshes).toBe(1)
    expect(waits).toEqual([])
    expect(hits.filter(u => u === '/a.mp4?v=0')).toHaveLength(1)
    expect(hits.filter(u => u === '/b.mp4?v=0')).toHaveLength(1)
    expect(hits).toContain('/b.mp4?v=1')
    expect(hits).toContain('/c.mp4?v=1')
    expect(await (await fetch(relay.url)).text()).toBe(initial)
    expect(hits.filter(u => u.startsWith('/media.m3u8'))).toHaveLength(2)
    expect(relay.error()).toBeUndefined()
  } finally {
    await relay.close(); origin.closeAllConnections()
    await new Promise<void>(r => origin.close(() => r()))
  }
})

test('fresh-URL retries are bounded and a changed segment layout is rejected', async () => {
  for (const changed of [false, true]) {
    let refreshes = 0
    const origin = createServer((req, res) => {
      const u = new URL(req.url!, 'http://localhost')
      if (u.pathname === '/media.m3u8') {
        res.end(`#EXTM3U\n#EXTINF:${changed && refreshes ? 2 : 1},\nseg.mp4?v=${refreshes}\n#EXT-X-ENDLIST\n`)
      } else res.writeHead(403).end('denied')
    })
    await new Promise<void>(r => origin.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(origin.address() as { port: number }).port}`
    const relay = await createHlsRelay(`${base}/media.m3u8`, {}, false, {
      maxAttempts: 1, maxRefreshes: 3, wait: async () => {},
      refreshSource: async () => `${base}/media.m3u8?v=${++refreshes}`,
    })
    try {
      const playlist = await (await fetch(relay.url)).text()
      const url = playlist.split('\n').find(l => l.startsWith('http'))!
      const r = await fetch(url)
      expect(r.status).toBe(502)
      await r.text()
      expect(refreshes).toBe(changed ? 1 : 3)
      expect(relay.error()?.message).toContain(changed ? '分片结构' : '重新取 CDN 链接 3 次')
    } finally {
      await relay.close(); origin.closeAllConnections()
      await new Promise<void>(r => origin.close(() => r()))
    }
  }
})

test('four media requests reach the CDN concurrently through the relay', async () => {
  let concurrent = 0, peak = 0
  const pending: Array<() => void> = []
  const origin = createServer((req, res) => {
    if (req.url === '/media.m3u8') {
      res.end('#EXTM3U\n' + [0, 1, 2, 3].map(i => `#EXTINF:1,\n${i}.mp4`).join('\n') + '\n#EXT-X-ENDLIST\n')
      return
    }
    concurrent++
    peak = Math.max(peak, concurrent)
    pending.push(() => { concurrent--; res.end(req.url) })
    // A serialized relay deadlocks here and fails the test's timeout.
    if (pending.length === 4) pending.splice(0).forEach(finish => finish())
  })
  await new Promise<void>(r => origin.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(origin.address() as { port: number }).port}`
  const relay = await createHlsRelay(`${base}/media.m3u8`, {})
  try {
    const playlist = await (await fetch(relay.url)).text()
    const urls = playlist.split('\n').filter(l => l.startsWith('http'))
    const values = await Promise.all(urls.map(async url => {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) })
      return r.text()
    }))
    expect(values).toEqual(['/0.mp4', '/1.mp4', '/2.mp4', '/3.mp4'])
    expect(peak).toBe(4)
    expect(relay.stats().peakConcurrentRequests).toBe(4)
  } finally {
    await relay.close(); origin.closeAllConnections()
    await new Promise<void>(r => origin.close(() => r()))
  }
})

test('temporary play/playlist failures consume the same refresh budget and recover', async () => {
  for (const mode of ['play', 'playlist', 'mixed-budget'] as const) {
    let calls = 0, oldSegmentHits = 0
    const waits: number[] = [], attempts: number[] = []
    const origin = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost')
      const version = Number(url.searchParams.get('v') ?? 0)
      if (url.pathname === '/media.m3u8') {
        if (mode === 'playlist' && version === 1) { res.writeHead(503).end('temporarily unavailable'); return }
        res.end(`#EXTM3U\n#EXTINF:1,\nseg.mp4?v=${version}\n#EXT-X-ENDLIST\n`)
        return
      }
      if (!version) oldSegmentHits++
      if (!version || mode === 'mixed-budget') res.writeHead(403).end('expired')
      else res.end('exact segment')
    })
    await new Promise<void>(r => origin.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(origin.address() as { port: number }).port}`
    const relay = await createHlsRelay(`${base}/media.m3u8?v=0`, {}, false, {
      maxAttempts: 1, maxRefreshes: 3,
      wait: async ms => { waits.push(ms) }, onRefresh: n => { attempts.push(n) },
      refreshSource: async () => {
        calls++
        if (calls === 1 && mode !== 'playlist') throw new Error('http 503: gateway temporarily unavailable')
        return `${base}/media.m3u8?v=${calls}`
      },
    })
    try {
      const playlist = await (await fetch(relay.url)).text()
      const segment = playlist.split('\n').find(l => l.startsWith('http'))!
      const result = await fetch(segment)
      const body = await result.text()
      expect(oldSegmentHits).toBe(1)
      if (mode === 'mixed-budget') {
        expect(result.status).toBe(502)
        expect(calls).toBe(3)
        expect(attempts).toEqual([1, 2, 3])
        expect(waits).toEqual([1000, 2000])
        expect(relay.error()).toBeInstanceOf(HlsRefreshError)
      } else {
        expect(result.status).toBe(200)
        expect(body).toBe('exact segment')
        expect(calls).toBe(2)
        expect(attempts).toEqual([1, 2])
        expect(waits).toEqual([1000])
        expect(relay.error()).toBeUndefined()
      }
    } finally {
      await relay.close(); origin.closeAllConnections()
      await new Promise<void>(r => origin.close(() => r()))
    }
  }
})

test('refresh stops immediately for login, key and structural failures', async () => {
  for (const failure of [new ReloginRequired('http 403: requires re-login'), new Error('重新取链后解密密钥改变'), new HlsRefreshError('分片结构改变')]) {
    let calls = 0
    const origin = createServer((req, res) => {
      if (req.url === '/media.m3u8') res.end('#EXTM3U\n#EXTINF:1,\nseg.mp4\n#EXT-X-ENDLIST\n')
      else res.writeHead(403).end('expired')
    })
    await new Promise<void>(r => origin.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(origin.address() as { port: number }).port}`
    const relay = await createHlsRelay(`${base}/media.m3u8`, {}, false, {
      maxAttempts: 1, wait: async () => { throw new Error('must not wait') },
      refreshSource: async () => { calls++; throw failure },
    })
    try {
      const playlist = await (await fetch(relay.url)).text()
      const segment = playlist.split('\n').find(l => l.startsWith('http'))!
      const result = await fetch(segment)
      expect(result.status).toBe(502)
      await result.text()
      expect(calls).toBe(1)
      expect(relay.error()?.message).toBe(failure.message)
    } finally {
      await relay.close(); origin.closeAllConnections()
      await new Promise<void>(r => origin.close(() => r()))
    }
  }
})
