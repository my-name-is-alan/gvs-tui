import { expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { finalizeCompletedName, reserveOutputPath } from './completed-naming.ts'
import { probeFinishedMedia } from './gvs-record.ts'
import { defaultIQSubtitleIndex, muxIQ, orderedIQSubtitles } from './iq-mux.ts'
import { sourceTag } from './name.ts'

const realMediaTest = ['ffmpeg', 'ffprobe'].every(bin => spawnSync(bin, ['-version'],
  { stdio: 'ignore', timeout: 8000 }).status === 0) ? test : test.skip
const ff = (args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args],
  { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 })

test('IQ defaults only explicitly simplified Chinese subtitles, preferring source over AI', () => {
  const subtitles = [
    { language: 'eng', title: '英语' },
    { language: 'zho', title: '繁体中文' },
    { language: 'zho', title: '简体中文 (AI)' },
    { language: 'zho', title: '简体中文' },
  ]
  expect(defaultIQSubtitleIndex(subtitles)).toBe(3)
  expect(defaultIQSubtitleIndex(subtitles.slice(0, 3))).toBe(2)
  for (const language of ['zh_CN', 'zh-Hans', 'zh-Hans-CN', 'zh-SG', 'chi-CN', 'zho-Hans', 'cmn-Hans', 'chs']) {
    expect(defaultIQSubtitleIndex([{ language, title: '中文' }])).toBe(0)
  }
  expect(defaultIQSubtitleIndex([{ language: 'zho', title: 'Chinese (Simplified)' }])).toBe(0)
  expect(defaultIQSubtitleIndex([{ language: 'zho', title: '簡體中文' }])).toBe(0)
  for (const sub of [
    { language: 'zho', title: '中文' },
    { language: 'zh-TW', title: 'Chinese' },
    { language: 'zh-Hant', title: 'Chinese' },
    { language: 'zh-Hans', title: '繁體中文' },
    { language: 'eng', title: 'English' },
  ]) expect(defaultIQSubtitleIndex([sub])).toBe(-1)
  expect(defaultIQSubtitleIndex([])).toBe(-1)
})

test('IQ puts preferred simplified then traditional subtitles first, preserving every other track in source order', () => {
  const subtitles = [
    { language: 'tha', title: '泰语 (AI)' },
    { language: 'zho', title: '繁体中文 (AI)' },
    { language: 'zho', title: '简体中文 (AI)' },
    { language: 'eng', title: '英语' },
    { language: 'zho', title: '简体中文' },
    { language: 'zho', title: '繁体中文' },
    { language: 'zho', title: '中文' },
  ]
  const original = [...subtitles]
  const ordered = orderedIQSubtitles(subtitles)
  expect(ordered).toEqual([subtitles[4], subtitles[5], subtitles[0], subtitles[1], subtitles[2], subtitles[3], subtitles[6]])
  expect(defaultIQSubtitleIndex(ordered)).toBe(0)
  expect(subtitles).toEqual(original)
  expect(orderedIQSubtitles([subtitles[0]!, subtitles[5]!, subtitles[3]!]))
    .toEqual([subtitles[5], subtitles[0], subtitles[3]])
  expect(orderedIQSubtitles([subtitles[0]!, subtitles[3]!, subtitles[6]!]))
    .toEqual([subtitles[0], subtitles[3], subtitles[6]])
  for (const language of ['zh_Hant', 'zh-TW', 'zh-HK', 'zh-MO', 'zho-Hant-TW', 'cht']) {
    const traditional = { language, title: 'Chinese' }
    expect(orderedIQSubtitles([subtitles[0]!, traditional, subtitles[4]!]))
      .toEqual([subtitles[4], traditional, subtitles[0]])
  }
  expect(orderedIQSubtitles([])).toEqual([])
})

realMediaTest('IQ mux moves the selected default first and publishes measured naming from a reserved path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gvs-iq-mux-'))
  try {
    const video = join(root, 'video.mkv'), aac = join(root, 'aac.mka'), ddp = join(root, 'ddp.m4a'), sub = join(root, 'sub.srt')
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=25', '-t', '0.3', '-c:v', 'mpeg4', video])
    ff(['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '0.3', '-c:a', 'aac', '-metadata:s:a:0', 'title=普通话 · AAC', aac])
    ff(['-f', 'lavfi', '-i', 'anullsrc=channel_layout=5.1:sample_rate=48000', '-t', '0.3', '-c:a', 'eac3', '-f', 'mp4', ddp])
    writeFileSync(sub, '1\n00:00:00,000 --> 00:00:00,200\n字幕\n')
    const dest = reserveOutputPath(join(root, 'provisional.mkv'))
    const options = { video, dest, reservedOutput: true, emit: () => {},
      audios: [{ path: aac, language: 'zho', title: 'AAC' }, { path: ddp, language: 'zho', title: 'Dolby', isDefault: true }],
      subtitles: [{ path: sub, language: 'zho', title: '中文' }] }
    const muxAudio = await muxIQ('ffmpeg', options)
    expect(muxAudio).toEqual({ index: 0, count: 2 })
    expect(statSync(dest).size).toBeGreaterThan(0)
    expect(readdirSync(root).some(file => file.startsWith('.gvs-iq-mux-'))).toBe(false)
    expect((await probeFinishedMedia(dest)).audio).toMatchObject({ status: 'confirmed', index: 0, codec: 'eac3', channels: 6 })
    const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', dest],
      { encoding: 'utf8', timeout: 10000 })).streams
    expect(streams.filter((s: { codec_type: string }) => s.codec_type === 'audio')).toHaveLength(2)
    const audios = streams.filter((s: { codec_type: string }) => s.codec_type === 'audio')
    expect(audios.every((s: { tags?: { title?: string } }) => !s.tags?.title)).toBe(true)
    expect(audios.map((s: { tags: { language: string } }) => s.tags.language)).toEqual(['zho', 'zho'])
    expect(audios.map((s: { codec_name: string }) => s.codec_name)).toEqual(['eac3', 'aac'])
    expect(audios.map((s: { disposition: { default: number } }) => s.disposition.default)).toEqual([1, 0])
    expect(streams.filter((s: { codec_type: string }) => s.codec_type === 'subtitle')).toHaveLength(1)
    const named = await finalizeCompletedName(dest, { kind: 'show', title: '海外节目', nameDots: '', year: 2026,
      season: 0, episode: 298, episodeTitle: '特别篇', height: 2160, codec: 'HEVC', source: sourceTag('iq'),
      group: 'WF', tmdbId: 0, container: 'mkv' }, { muxAudio })
    expect(named.note).toBeUndefined()
    expect(basename(named.output)).toContain('海外节目.S00E298.特别篇.2026.')
    expect(basename(named.output)).toEndWith('.IQ.WEB-DL.MPEG4.DDP.5.1-WF.mkv')
    expect(basename(named.output)).not.toMatch(/2160p|HEVC|HQ|MAXPLUS|25fps/)

    const aacDest = reserveOutputPath(join(root, 'default-aac.mkv'))
    await muxIQ('ffmpeg', { ...options, dest: aacDest, audios: [
      { ...options.audios[1]!, isDefault: false }, { ...options.audios[0]!, isDefault: true },
    ] })
    expect((await probeFinishedMedia(aacDest)).audio).toMatchObject({ index: 0, codec: 'aac', channels: 2 })

    // Publication refuses a reservation modified during mux/validation.
    const occupied = reserveOutputPath(join(root, 'occupied.mkv'))
    await expect(muxIQ('ffmpeg', { ...options, dest: occupied, emit: () => writeFileSync(occupied, 'existing library file') }))
      .rejects.toThrow('未覆盖现有文件')
    expect(readFileSync(occupied, 'utf8')).toBe('existing library file')
    expect(readdirSync(root).some(file => file.startsWith('.gvs-iq-mux-'))).toBe(false)

    // Legacy queues retain their original destination and ffmpeg's no-overwrite behavior.
    const legacy = join(root, 'legacy.mkv')
    await muxIQ('ffmpeg', { ...options, dest: legacy, reservedOutput: false })
    expect((await probeFinishedMedia(legacy)).audio?.codec).toBe('eac3')
    const before = readFileSync(legacy)
    await expect(muxIQ('ffmpeg', { ...options, dest: legacy, reservedOutput: false })).rejects.toThrow()
    expect(readFileSync(legacy)).toEqual(before)
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 60000)

realMediaTest('IQ mux puts simplified and traditional subtitles first with correct contents, default and audio flags', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gvs-iq-subtitle-default-'))
  try {
    const video = join(root, 'video.mkv'), audio = join(root, 'audio.m4a'), sub = join(root, 'sub.srt')
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=25', '-t', '0.3', '-c:v', 'mpeg4', video])
    ff(['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '0.3', '-c:a', 'aac', audio])
    writeFileSync(sub, '1\n00:00:00,000 --> 00:00:00,200\n字幕\n')
    const audios = [{ path: audio, language: 'ind', title: '原声', isDefault: true }]
    // Match the downloaded show's mixed subtitle ordering and shared zho tags.
    const subtitles = [
      { path: sub, language: 'tha', title: '泰语 (AI)' },
      { path: sub, language: 'eng', title: '英语' },
      { path: sub, language: 'zho', title: '简体中文 (AI)' },
      { path: sub, language: 'zho', title: '简体中文' },
      { path: sub, language: 'zho', title: '繁体中文' },
    ].map((s, i) => {
      const path = join(root, `sub-${i}.srt`)
      writeFileSync(path, `1\n00:00:00,000 --> 00:00:00,200\n${s.title}\n`)
      return { ...s, path }
    })
    const dest = reserveOutputPath(join(root, 'with-simplified.mkv'))
    await muxIQ('ffmpeg', { video, audios, subtitles, dest, reservedOutput: true, emit: () => {} })
    const probe = (path: string) => JSON.parse(execFileSync('ffprobe',
      ['-v', 'error', '-show_streams', '-of', 'json', path], { encoding: 'utf8', timeout: 10000 })).streams
    const streams = probe(dest)
    const subs = streams.filter((s: { codec_type: string }) => s.codec_type === 'subtitle')
    expect(subs).toHaveLength(3)
    expect(subs.map((s: { tags: { title: string } }) => s.tags.title))
      .toEqual(['简体中文', '繁体中文', '英语'])
    expect(subs.map((s: { disposition: { default: number } }) => s.disposition.default)).toEqual([1, 0, 0])
    expect(subs[0].tags).toMatchObject({ language: 'zho', title: '简体中文' })
    for (let i = 0; i < subs.length; i++) {
      const text = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', dest, '-map', `0:s:${i}`, '-f', 'srt', '-'],
        { encoding: 'utf8', timeout: 10000 })
      expect(text).toContain(subs[i].tags.title)
    }
    expect(subs.every((s: { disposition: { forced: number } }) => s.disposition.forced === 0)).toBe(true)
    expect(streams.find((s: { codec_type: string }) => s.codec_type === 'audio').disposition.default).toBe(1)

    const legacy = join(root, 'without-simplified.mkv')
    await muxIQ('ffmpeg', { video, audios, subtitles: subtitles.filter(s => !s.title.includes('简体')),
      dest: legacy, reservedOutput: false, emit: () => {} })
    const legacySubs = probe(legacy).filter((s: { codec_type: string }) => s.codec_type === 'subtitle')
    expect(legacySubs.map((s: { tags: { title: string } }) => s.tags.title)).toEqual(['简体中文', '繁体中文', '英语'])
    expect(legacySubs.map((s: { disposition: { default: number } }) => s.disposition.default)).toEqual([1, 0, 0])
    const convertedText = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', legacy, '-map', '0:s:0', '-f', 'srt', '-'],
      { encoding: 'utf8', timeout: 10000 })
    expect(convertedText).toContain('繁体中文')
    expect(readdirSync(root).some(file => file.startsWith('.gvs-iq-mux-'))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 30000)

test('IQ invalid reservations, mux failures and cancellation keep existing output and clean staging', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gvs-iq-mux-fail-'))
  try {
    const dest = join(root, 'existing.mkv')
    const options = { video: join(root, 'missing-video'), audios: [{ path: join(root, 'missing-audio'), language: 'und', title: '原声' }],
      subtitles: [], dest, reservedOutput: true, emit: () => {} }
    writeFileSync(dest, 'existing media')
    await expect(muxIQ('nonexistent-ffmpeg', options)).rejects.toThrow('未覆盖现有文件')
    expect(readFileSync(dest, 'utf8')).toBe('existing media')
    const reserved = reserveOutputPath(join(root, 'failed.mkv'))
    await expect(muxIQ('nonexistent-ffmpeg', { ...options, dest: reserved })).rejects.toThrow()
    expect(statSync(reserved).size).toBe(0)
    expect(readdirSync(root).some(file => file.startsWith('.gvs-iq-mux-'))).toBe(false)
    await expect(muxIQ('nonexistent-ffmpeg', { ...options, dest: reserved, signal: AbortSignal.abort() })).rejects.toThrow()
    expect(statSync(reserved).size).toBe(0)
    expect(readdirSync(root).some(file => file.startsWith('.gvs-iq-mux-'))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

realMediaTest('IQ final MKV contains an OpenCC Chinese pair, excludes AI alternatives and keeps AI-only provenance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gvs-iq-opencc-final-'))
  try {
    const video = join(root, 'video.mkv'), audio = join(root, 'audio.m4a')
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=25', '-t', '0.3', '-c:v', 'mpeg4', video])
    ff(['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '0.3', '-c:a', 'aac', audio])
    const sc = join(root, 'simplified.srt'), tc = join(root, 'traditional.vtt'), eng = join(root, 'english.srt')
    writeFileSync(sc, '1\n00:00:00,000 --> 00:00:00,200\n汉语与音乐 后台发表\n\n')
    writeFileSync(tc, 'WEBVTT\n\n00:00:00.000 --> 00:00:00.200\n漢語與音樂 後臺發表\n\n')
    writeFileSync(eng, '1\n00:00:00,000 --> 00:00:00,200\nEnglish subtitle\n\n')
    const cases = [
      { name: 'normal-sc', source: { path: sc, language: 'zh-Hans', title: '简体中文' },
        titles: ['简体中文', '繁体中文', '英语'], texts: ['汉语与音乐 后台发表', '漢語與音樂 後臺發表'] },
      { name: 'normal-tc', source: { path: tc, language: 'zh-Hant', title: '繁体中文' },
        titles: ['简体中文', '繁体中文', '英语'], texts: ['汉语与音乐 后台发表', '漢語與音樂 後臺發表'] },
      { name: 'ai-only', source: { path: sc, language: 'zh-Hans', title: '简体中文', ai: true },
        titles: ['简体中文 (AI)', '繁体中文 (AI)', '英语'], texts: ['汉语与音乐 后台发表', '漢語與音樂 後臺發表'] },
    ]
    for (const scenario of cases) {
      const subtitles = [{ path: eng, language: 'eng', title: '英语' },
        { path: eng, language: 'eng', title: '英语 (AI)' }, scenario.source,
        ...(scenario.name === 'ai-only' ? [] : [{ path: sc, language: 'zh-Hans', title: '简体中文 (AI)' },
          { path: tc, language: 'zh-Hant', title: '繁体中文 (AI)' }])]
      const dest = reserveOutputPath(join(root, `${scenario.name}.mkv`))
      expect(await muxIQ('ffmpeg', { video, audios: [{ path: audio, language: 'ind', title: '原声', isDefault: true }],
        subtitles, dest, reservedOutput: true, emit: () => {} })).toEqual({ index: 0, count: 1 })
      const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', dest], { encoding: 'utf8' })).streams
      const subs = streams.filter((s: { codec_type: string }) => s.codec_type === 'subtitle')
      expect(subs.map((s: { tags: { title: string } }) => s.tags.title)).toEqual(scenario.titles)
      expect(subs.map((s: { disposition: { default: number } }) => s.disposition.default)).toEqual([1, 0, 0])
      // AAC priming can cause ffmpeg to shift every muxed track together.
      // Compare converted cues with the untouched English track, not zero.
      const english = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', dest, '-map', '0:s:2', '-f', 'srt', '-'], { encoding: 'utf8' })
      const timing = /\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/
      const reference = english.match(timing)?.[0]
      expect(reference).toBeDefined()
      const millis = (stamp: string) => {
        const [h, m, s, ms] = stamp.split(/[:,]/).map(Number)
        return h! * 3600000 + m! * 60000 + s! * 1000 + ms!
      }
      const [start, end] = reference!.split(' --> ')
      expect(millis(end!) - millis(start!)).toBe(200)
      for (let index = 0; index < 2; index++) {
        const text = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', dest, '-map', `0:s:${index}`, '-f', 'srt', '-'], { encoding: 'utf8' })
        expect(text).toContain(scenario.texts[index]!)
        expect(text.match(timing)?.[0]).toBe(reference)
      }
      expect(readdirSync(root).some(file => file.startsWith('.gvs-iq-mux-'))).toBe(false)
    }
    expect(readFileSync(sc, 'utf8')).toContain('汉语与音乐 后台发表')
    expect(readFileSync(tc, 'utf8')).toContain('漢語與音樂 後臺發表')
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 30000)
