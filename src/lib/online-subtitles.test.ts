import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachSubtitleArgs, chineseVariant, downloadSubtitles, onlineSubtitles, orderSubtitles, pickSubtitles, subtitleFileName } from './online-subtitles.ts'

describe('crunchyroll online subtitles', () => {
  const gateway = {
    subtitles: [
      { id: 'zh-Hans', lang: 'zh-Hans', label: '简体中文', format: 'ass', url: 'https://cdn.example/zh.ass?t=exp=1~hmac=aa' },
      { id: 'en-US', lang: 'en-US', label: '英语', format: 'ass', url: 'https://cdn.example/en.ass?t=exp=1~hmac=bb' },
      { id: 'de-DE', lang: 'de-DE', label: '德语', format: 'ass', url: '' },
    ],
  }

  test('reads the gateway table and drops rows without a URL', () => {
    const rows = onlineSubtitles(gateway)
    expect(rows.map(r => r.id)).toEqual(['zh-Hans', 'en-US'])
    expect(rows[0]!.url).toContain('~hmac=aa')
  })

  test('only the ticked locales are fetched, in gateway order', () => {
    const rows = onlineSubtitles(gateway)
    expect(pickSubtitles(rows, ['en-US']).map(r => r.id)).toEqual(['en-US'])
    expect(pickSubtitles(rows, ['en-US', 'zh-Hans']).map(r => r.id)).toEqual(['zh-Hans', 'en-US'])
    expect(pickSubtitles(rows, undefined)).toEqual([])
    expect(pickSubtitles(rows, [])).toEqual([])
  })

  test('simplified / traditional detection covers the BCP 47 forms CR returns', () => {
    expect(chineseVariant('zh-Hans')).toBe('hans')
    expect(chineseVariant('zh-CN')).toBe('hans')
    expect(chineseVariant('zh-Hant')).toBe('hant')
    expect(chineseVariant('zh-TW')).toBe('hant')
    expect(chineseVariant('zh-HK')).toBe('hant')
    expect(chineseVariant('zh')).toBe('hans')
    expect(chineseVariant('', '繁体中文')).toBe('hant')
    expect(chineseVariant('en-US')).toBe('')
  })

  test('track order puts simplified first, then traditional, then the rest', () => {
    const sub = (id: string, lang = id) => ({ id, lang, label: id, format: 'ass', url: 'u' })
    const ordered = orderSubtitles([sub('en-US'), sub('zh-Hant'), sub('de-DE'), sub('zh-Hans')])
    expect(ordered.map(s => s.id)).toEqual(['zh-Hans', 'zh-Hant', 'en-US', 'de-DE'])
  })

  test('file names stay path-safe and keep the real extension', () => {
    expect(subtitleFileName({ id: 'zh-Hans', lang: 'zh-Hans', label: '简体 中文', format: 'ass', url: 'u' })).toBe('简体_中文.ass')
    expect(subtitleFileName({ id: 'en-US', lang: 'en-US', label: '', format: 'vtt', url: 'u' })).toBe('en-US.vtt')
  })

  test('mkvmerge args carry language, name, default flag and output last', () => {
    const args = attachSubtitleArgs('ep.mkv', 'ep.mkv.subs.mkv', [
      { path: 'a.ass', sub: { id: 'zh-Hans', lang: 'zh-Hans', label: '简体中文', format: 'ass', url: 'u' }, isDefault: true },
      { path: 'b.ass', sub: { id: 'en-US', lang: 'en-US', label: '英语', format: 'ass', url: 'u' }, isDefault: false },
    ])
    expect(args[0]).toBe('ep.mkv')
    // 简体走带脚本的 IETF 标签，英语仍用 ISO 639-2
    expect(args).toContain('0:zh-Hans')
    expect(args).toContain('0:eng')
    expect(args).not.toContain('0:chi')
    expect(args).toContain('--default-track-flag')
    expect(args.slice(-3)).toEqual(['b.ass', '-o', 'ep.mkv.subs.mkv'])
    expect(args.filter(a => a === '-o')).toHaveLength(1)
  })

  test('traditional Chinese subtitles carry zh-Hant so players can auto-select', () => {
    const args = attachSubtitleArgs('ep.mkv', 'out.mkv', [
      { path: 'c.ass', sub: { id: 'zh-HK', lang: 'zh-HK', label: '繁體中文（香港）', format: 'ass', url: 'u' } },
    ])
    expect(args).toContain('0:zh-Hant')
  })

  test('downloads through the injected media transport, not a bare fetch', async () => {
    const seen: string[] = []
    const dir = mkdtempSync(join(tmpdir(), 'gvs-subs-'))
    try {
      const files = await downloadSubtitles(
        [{ id: 'zh-Hans', lang: 'zh-Hans', label: '简体中文', format: 'ass', url: 'https://cdn.example/zh.ass' }],
        dir,
        { fetcher: async (url) => { seen.push(url); return new Response(new Uint8Array([1, 2, 3]), { status: 200 }) } },
      )
      expect(seen).toEqual(['https://cdn.example/zh.ass'])
      expect(files.map(f => f.sub.id)).toEqual(['zh-Hans'])
      expect(readFileSync(files[0]!.path).length).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a failing transport surfaces as an error instead of an empty track', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gvs-subs-'))
    try {
      await expect(downloadSubtitles(
        [{ id: 'zh-Hans', lang: 'zh-Hans', label: '简体中文', format: 'ass', url: 'https://cdn.example/zh.ass' }],
        dir,
        { fetcher: async () => new Response('blocked', { status: 403 }) },
      )).rejects.toThrow('HTTP 403')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})