import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { prepareIQCNSubtitles, iqcnSubtitleTags } from './iqcn-subtitles.ts'
import { defaultIQSubtitleIndex } from './iq-subtitles.ts'
import type { GwClient } from './client.ts'

const srt = '1\n00:00:01,000 --> 00:00:02,000\n汉语与音乐\n'
const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000\n漢語與音樂\n'
function fixture(rows: Array<Record<string, unknown>>, texts: string[]) {
  const calls: number[] = []
  const cli = { invoke: async (_provider: string, action: string, input: Record<string, unknown>) => {
    expect(action).toBe('download-subtitle')
    const index = Number(input.index)
    calls.push(index)
    const raw = index === 1 ? gzipSync(Buffer.from(texts[index]!)) : Buffer.from(texts[index]!)
    return { index, language_id: rows[index]!.language_id, format: input.format, bytes: raw.length, data: raw.toString('base64') }
  } } as unknown as GwClient
  return { cli, calls, plan: { subtitles: rows } }
}

test('domestic traditional-only VTT gets a simplified default while keeping English', async () => {
  const work = mkdtempSync(join(tmpdir(), 'iqcn-subs-'))
  const { cli, plan } = fixture([{ index: 0, language_id: 3, formats: ['srt'] }, { index: 1, language_id: 2, formats: ['webvtt'] }], [srt.replace('汉语与音乐', 'English'), vtt])
  const result = await prepareIQCNSubtitles(cli, plan, 'plan', work)
  expect(result.subtitles.map(s => s.title)).toEqual(['简体中文', '繁体中文', '英语'])
  expect(result.subtitles.map(s => s.language)).toEqual(['zho', 'zho', 'eng'])
  expect(defaultIQSubtitleIndex(result.subtitles)).toBe(0)
  expect(readFileSync(result.subtitles[0]!.path, 'utf8')).toContain('汉语与音乐')
  expect(readFileSync(result.subtitles[1]!.path, 'utf8')).toBe(vtt)
})

test('domestic native pair avoids conversion and skips AI alternatives using IQ rules', async () => {
  const work = mkdtempSync(join(tmpdir(), 'iqcn-native-subs-'))
  const { cli, calls, plan } = fixture([
    { index: 0, language_id: 2, formats: ['webvtt'] },
    { index: 1, language_id: 1, formats: ['srt'] },
    { index: 2, language_id: 1, title: '简体中文 (AI)', ai: true, formats: ['srt'] },
  ], [vtt, srt, srt])
  const result = await prepareIQCNSubtitles(cli, plan, 'plan', work)
  expect(calls).toEqual([0, 1])
  expect(result.subtitles.map(s => s.title)).toEqual(['简体中文', '繁体中文'])
  expect(result.note).toBeUndefined()
})

test('domestic subtitles reject wrong language and invalid cue data', async () => {
  const work = mkdtempSync(join(tmpdir(), 'iqcn-wrong-subs-'))
  for (const [language, text] of [[3, srt], [1, '<html>error</html>']] as const) {
    const raw = Buffer.from(text)
    const cli = { invoke: async () => ({ index: 0, language_id: language, format: 'srt', bytes: raw.length, data: raw.toString('base64') }) } as unknown as GwClient
    await expect(prepareIQCNSubtitles(cli, { subtitles: [{ index: 0, language_id: 1, formats: ['srt'] }] }, 'plan', work)).rejects.toThrow()
  }
})

test('missing and unknown-language subtitles are not labeled Chinese', async () => {
  const { cli, calls } = fixture([], [])
  const result = await prepareIQCNSubtitles(cli, {}, 'plan', tmpdir())
  expect(result.subtitles).toEqual([])
  expect(calls).toEqual([])
  expect(iqcnSubtitleTags({ language_id: 999 })).toEqual({ language: 'und', title: '字幕语言 999', ai: false })
})

test('cancellation during subtitle retrieval does not start conversion', async () => {
  const controller = new AbortController()
  const raw = Buffer.from(srt)
  const cli = { invoke: async () => {
    controller.abort()
    return { index: 0, language_id: 1, format: 'srt', bytes: raw.length, data: raw.toString('base64') }
  } } as unknown as GwClient
  await expect(prepareIQCNSubtitles(cli, { subtitles: [{ index: 0, language_id: 1, formats: ['srt'] }] }, 'plan', tmpdir(), controller.signal)).rejects.toThrow()
})
