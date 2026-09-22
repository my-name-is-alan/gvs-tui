import { describe, expect, test } from 'bun:test'
import { pickTencentDownloadURL, pickURL, tencentPlayProbeOk } from './media.ts'

describe('pickURL tencent formats fallback', () => {
  test('reads playlist_url from formats[] when top-level url missing', () => {
    expect(
      pickURL({
        formats: [
          { name: 'fhd', playlist_url: 'https://cdn.example/a.m3u8?vkey=abc' },
          { name: 'hd', url: 'https://cdn.example/b.mp4' },
        ],
      }),
    ).toBe('https://cdn.example/a.m3u8?vkey=abc')
  })

  test('still prefers video.url', () => {
    expect(
      pickURL({
        video: { url: 'https://cdn.example/top.mp4' },
        formats: [{ playlist_url: 'https://cdn.example/fmt.m3u8' }],
      }),
    ).toBe('https://cdn.example/top.mp4')
  })
})

describe('tencentPlayProbeOk', () => {
  test('formats-only catalog without url is success', () => {
    const r = tencentPlayProbeOk({
      formats: [
        { id: 1, name: 'fhd', cname: '蓝光', caption: 'soft' },
        { id: 2, name: 'hd', cname: '超清', caption: 'hard' },
      ],
      has_url: false,
    })
    expect(r.ok).toBe(true)
    expect(r.via).toBe('formats')
  })

  test('has_url true without formats is success', () => {
    expect(tencentPlayProbeOk({ has_url: true }).ok).toBe(true)
    expect(tencentPlayProbeOk({ has_url: true }).via).toBe('has_url')
  })

  test('network_error surfaces Chinese-friendly message', () => {
    const r = tencentPlayProbeOk({
      network_error: true,
      error: 'TV play request failed',
      formats: [{ name: 'fhd' }],
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('TV')
  })

  test('result.error fails even with formats', () => {
    const r = tencentPlayProbeOk({
      error: '账号无权益',
      formats: [{ name: 'fhd' }],
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('账号无权益')
  })

  test('empty payload fails with address message', () => {
    const r = tencentPlayProbeOk({})
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('可用视频地址')
  })

  test('videos[] row with url counts as success', () => {
    const r = tencentPlayProbeOk({
      videos: [{ video: { url: 'https://cdn.example/v.mp4' } }, {}],
    })
    expect(r.ok).toBe(true)
    expect(r.via).toBe('videos')
  })
  test('em=93 fails with Chinese entitlement lock status even if formats present', () => {
    const r = tencentPlayProbeOk({
      em: '93',
      has_url: false,
      formats: [{ name: 'fhd', caption: 'soft' }],
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('em=93')
    expect(r.reason).toContain('勿反复重试')
  })

  test('限制播放 message maps to em=93 guidance', () => {
    const r = tencentPlayProbeOk({ em: '限制播放', has_url: false })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('权益风控')
  })

})

describe('pickTencentDownloadURL', () => {
  test('source fname+vkey builds videohywb URL', () => {
    const u = pickTencentDownloadURL(
      {
        has_url: true,
        formats: [
          { name: 'maxplus', caption: 'soft' },
          {
            name: 'source',
            stream: 'original',
            fname: 'gzc_1000102_abc.f10005.mp4',
            vkey: 'VKEY+/=',
          },
        ],
      },
      { needSource: true },
    )
    expect(u).toBe(
      'https://videohywb.tc.qq.com/gzc_1000102_abc.f10005.mp4?vkey=VKEY%2B%2F%3D',
    )
  })

  test('source prefers gateway-emitted url over rebuild', () => {
    const u = pickTencentDownloadURL(
      {
        formats: [
          {
            name: 'source',
            fname: 'a.mp4',
            vkey: 'k',
            url: 'https://videohywb.tc.qq.com/a.mp4?vkey=k',
          },
        ],
      },
      { stream: 'source' },
    )
    expect(u).toBe('https://videohywb.tc.qq.com/a.mp4?vkey=k')
  })

  test('source row without vkey/fname throws 原画缺少', () => {
    expect(() =>
      pickTencentDownloadURL(
        { formats: [{ name: 'source', stream: 'original' }] },
        { needSource: true },
      ),
    ).toThrow(/原画缺少 vkey\/fname/)
  })

  test('HLS top-level url via pickURL path', () => {
    const u = pickTencentDownloadURL(
      {
        url: 'https://cdn.example/playlist.m3u8?vkey=abc',
        playlist_url: 'https://cdn.example/playlist.m3u8?vkey=abc',
        video: {
          url: 'https://cdn.example/playlist.m3u8?vkey=abc',
          playlist_url: 'https://cdn.example/playlist.m3u8?vkey=abc',
        },
        formats: [{ name: 'maxplus', caption: 'soft' }],
      },
      { stream: 'maxplus', caption: 'soft' },
    )
    expect(u).toContain('cdn.example/playlist.m3u8')
  })

  test('formats fallback matches caption+defn when top-level empty', () => {
    const u = pickTencentDownloadURL(
      {
        formats: [
          { name: 'fhd', caption: 'hard', playlist_url: 'https://cdn.example/hard.m3u8' },
          { name: 'maxplus', caption: 'soft', playlist_url: 'https://cdn.example/soft.m3u8' },
        ],
      },
      { stream: 'maxplus', caption: 'soft' },
    )
    expect(u).toBe('https://cdn.example/soft.m3u8')
  })
})
