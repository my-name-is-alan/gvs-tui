import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertIQSubtitleText, isIQSubtitleAI, prepareIQSubtitles, selectIQSubtitles } from './iq-subtitles.ts'

const sc = { language: 'zho', title: '简体中文' }
const tc = { language: 'zho', title: '繁体中文' }
const aiSC = { language: 'zh-Hans', title: '中文', ai: true }
const aiTC = { language: 'zh-Hant', title: 'Chinese (AI)' }
const english = { language: 'eng', title: '英语' }
const aiThai = { language: 'tha', title: '泰语 (AI)' }
const srt = '1\r\n00:00:01,000 --> 00:00:03,000\r\n<b class="简体">汉语与音乐</b> &amp; <i>后台发表</i>\r\n\r\n'

test('normal Chinese excludes both AI Chinese variants; other languages retain only normal subtitles', () => {
  const tracks = [aiThai, aiTC, english, sc, aiSC, tc, { language: 'tha', title: 'Thai' }]
  expect(selectIQSubtitles(tracks)).toEqual([english, sc, tc, tracks[6]])
  expect(selectIQSubtitles([aiSC, aiTC, sc, english])).toEqual([sc, english])
  expect(selectIQSubtitles([aiSC, tc, aiTC, aiThai])).toEqual([tc])
  expect(tracks).toHaveLength(7)
})

test('AI simplified/traditional is used only when both normal Chinese scripts are absent', () => {
  expect(selectIQSubtitles([aiThai, english, aiTC, aiSC])).toEqual([english, aiTC, aiSC])
  expect(selectIQSubtitles([aiThai, english])).toEqual([english])
  expect(selectIQSubtitles([{ language: 'zho', title: '中文 (AI)' }])).toEqual([])
  expect(selectIQSubtitles([])).toEqual([])
})

test('AI metadata and explicit labels are recognized without treating Thai as AI', () => {
  for (const title of ['简体中文 (AI)', '繁體中文（ＡＩ）', '英语 · AI 翻译', 'AI字幕', '机器翻译', '機器翻譯', '自动翻译'])
    expect(isIQSubtitleAI({ language: 'und', title })).toBe(true)
  expect(isIQSubtitleAI({ language: 'eng', title: 'English', ai: true })).toBe(true)
  for (const title of ['Thai', 'ไทย', '简体中文', '繁體中文', 'English'])
    expect(isIQSubtitleAI({ language: 'und', title })).toBe(false)
})

test('OpenCC converts SRT cue text in both directions, preserving timings, markup, entities and CRLF', async () => {
  const traditional = await convertIQSubtitleText(srt, 'traditional')
  expect(traditional).toBe(srt.replace('汉语与音乐', '漢語與音樂').replace('后台发表', '後臺發表'))
  expect(await convertIQSubtitleText(traditional, 'simplified')).toBe(srt)
})

test('OpenCC leaves WebVTT headers, comments, style, regions, cue IDs and inline timestamps intact', async () => {
  const vtt = '\uFEFFWEBVTT\r\nLanguage: 简体中文\r\n\r\nNOTE 简体注释\r\n汉语注释\r\n\r\n' +
    'STYLE\r\n::cue(.简体) { font-family: "汉语"; }\r\n\r\nREGION\r\nid:简体区域\r\n\r\n' +
    '简体编号\r\n00:01.000 --> 00:03.000 region:简体区域 align:start\r\n<v 简体人物><c.简体>汉语</c></v><00:02.000>音乐 &amp; 后台\r\n\r\n'
  const output = await convertIQSubtitleText(vtt, 'traditional')
  expect(output).toBe(vtt.replace('>汉语<', '>漢語<').replace('>音乐 &amp; 后台', '>音樂 &amp; 後臺'))
  expect(output.charCodeAt(0)).toBe(0xfeff)
})

test('a sole normal simplified track produces traditional locally and never uses the available AI substitute', async () => {
  const root = mkdtempSync(join(tmpdir(), 'iq-opencc-sc-'))
  try {
    const path = join(root, 'source.srt'); writeFileSync(path, srt)
    const tracks = [{ ...english, path }, { ...aiTC, path }, { ...sc, path }, { ...aiSC, path }, { ...aiThai, path }]
    const result = await prepareIQSubtitles(tracks, root)
    expect(result.note).toBeUndefined()
    expect(result.subtitles.map(s => s.title)).toEqual(['简体中文', '繁体中文', '英语'])
    expect(result.subtitles[1]).toMatchObject({ language: 'zho', ai: false })
    expect(readFileSync(result.subtitles[1]!.path, 'utf8')).toContain('漢語與音樂')
    expect(readFileSync(path, 'utf8')).toBe(srt)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a sole normal traditional VTT track produces simplified first and preserves source and cues', async () => {
  const root = mkdtempSync(join(tmpdir(), 'iq-opencc-tc-'))
  try {
    const path = join(root, 'source.vtt'), text = 'WEBVTT\n\n01\n00:01.000 --> 00:03.000\n繁體字幕與音樂\n\n'
    writeFileSync(path, text)
    const result = await prepareIQSubtitles([{ ...tc, path }, { ...aiSC, path }, { ...english, path }], root)
    expect(result.subtitles.map(s => s.title)).toEqual(['简体中文', '繁体中文', '英语'])
    expect(result.subtitles[0]!.path).toEndWith('.vtt')
    expect(readFileSync(result.subtitles[0]!.path, 'utf8')).toBe(text.replace('繁體字幕與音樂', '繁体字幕与音乐'))
    expect(readFileSync(path, 'utf8')).toBe(text)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('both normal Chinese scripts need no conversion; other normal tracks retain source order', async () => {
  const tracks = [{ ...english, path: 'unused' }, { ...tc, path: 'unused' }, { ...sc, path: 'unused' },
    { language: 'jpn', title: '日本語', path: 'unused' }, { ...aiThai, path: 'unused' }]
  const result = await prepareIQSubtitles(tracks, '/unused', undefined, async () => { throw new Error('must not convert') })
  expect(result).toEqual({ subtitles: [tracks[2], tracks[1], tracks[0], tracks[3]] })
})

test('AI-only Chinese remains marked AI, including a generated missing counterpart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'iq-opencc-ai-'))
  try {
    const path = join(root, 'source.srt'); writeFileSync(path, srt)
    const both = await prepareIQSubtitles([{ ...aiTC, path }, { ...aiSC, path }, { ...aiThai, path }, { ...english, path }], root)
    expect(both.subtitles.map(s => s.title)).toEqual(['中文 (AI)', aiTC.title, english.title])
    expect(readdirSync(root)).toEqual(['source.srt'])
    const single = await prepareIQSubtitles([{ ...aiSC, path }, { ...aiThai, path }, { ...english, path }], root)
    expect(single.subtitles.map(s => s.title)).toEqual(['中文 (AI)', '繁体中文 (AI)', english.title])
    expect(single.subtitles[1]?.ai).toBe(true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('unknown Chinese script is retained without guessing or creating a default pair', async () => {
  const tracks = [{ language: 'zho', title: '中文', path: 'unused' }, { ...english, path: 'unused' }]
  expect(await prepareIQSubtitles(tracks, '/unused')).toEqual({ subtitles: tracks })
})

test('failed or malformed conversion retains the normal source and does not fall back to AI', async () => {
  const root = mkdtempSync(join(tmpdir(), 'iq-opencc-fail-'))
  try {
    const path = join(root, 'source.srt'); writeFileSync(path, '<html>错误响应</html>')
    const tracks = [{ ...sc, path }, { ...aiTC, path }, { ...english, path }]
    const result = await prepareIQSubtitles(tracks, root)
    expect(result).toEqual({ subtitles: [tracks[0], tracks[2]], note: '繁体中文 OpenCC 转换失败，已保留可用原字幕' })
    expect(readdirSync(root)).toEqual(['source.srt'])
    writeFileSync(path, srt)
    expect((await prepareIQSubtitles(tracks, root, undefined, async () => { throw new Error('converter unavailable') })).note).toContain('转换失败')
    writeFileSync(path, Buffer.from([0xff, 0xfe, 0x01, 0x00]))
    expect((await prepareIQSubtitles(tracks, root)).note).toContain('转换失败')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('cancellation during conversion is not softened into success or a partial generated subtitle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'iq-opencc-stop-'))
  try {
    const path = join(root, 'source.srt'); writeFileSync(path, srt)
    const abort = new AbortController()
    await expect(prepareIQSubtitles([{ ...sc, path }], root, abort.signal, async text => {
      abort.abort(); return text
    })).rejects.toThrow()
    expect(readdirSync(root)).toEqual(['source.srt'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
