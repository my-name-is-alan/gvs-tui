import { describe, expect, test } from 'bun:test'
import { pickURL, tencentPlayProbeOk } from './media.ts'

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
})
