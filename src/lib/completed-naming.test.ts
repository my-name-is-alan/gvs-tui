import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { tencentActualVersion, type MediaSpecs } from './actual-version.ts'
import { finalizeCompletedName, iqcnNamingEvidence, renameCompletedFile, reserveOutputPath, tencentNamingEvidence, usesMeasuredNaming, youkuNamingEvidence } from './completed-naming.ts'
import { completedFilename, filename, folder, sourceTag, type Naming } from './name.ts'
import { finishedVersionRecord, saveVersionRecord } from './gvs-record.ts'

const naming = (patch: Partial<Naming> = {}): Naming => ({ kind: 'show', title: '节目', nameDots: '', year: 2026,
  season: 1, episode: 1, height: 2160, codec: 'H265', source: 'TX', group: 'WF', tmdbId: 0, container: 'mkv', ...patch })
const media = (patch: Partial<MediaSpecs> = {}): MediaSpecs => ({ status: 'probed', width: 3840, height: 2160,
  codec: 'hevc', fps: 24, dynamicRange: 'SDR', audio: { status: 'confirmed', codec: 'aac', channels: 2 }, ...patch })

test('four requested names preserve title order, S00, three-digit episodes and measured suffixes', () => {
  expect(completedFilename(naming({ title: '心动的信号', season: 0, episode: 298, year: 2018,
    episodeTitle: '花絮特辑：星星柏涵约会真诚的情话好动人' }), media({ fps: 60, audio: { status: 'confirmed', codec: 'eac3', channels: 2 } })))
    .toBe('心动的信号.S00E298.花絮特辑.星星柏涵约会真诚的情话好动人.2018.2160p.TX.WEB-DL.60fps.HEVC.DDP.2.0-WF.mkv')
  expect(completedFilename(naming({ kind: 'movie', title: '四重心影', source: 'YK' }), media()))
    .toBe('四重心影.2026.2160p.YOUKU.WEB-DL.HEVC.AAC.2.0-WF.mkv')
  expect(completedFilename(naming({ title: '一瓯春', episode: 29, episodeTitle: '朱门盛景，终究一场梦', source: 'YK' }), media({ dynamicRange: 'DV', fps: 60 }), 'HQ'))
    .toBe('一瓯春.S01E29.朱门盛景.终究一场梦.2026.2160p.YOUKU.WEB-DL.HQ.DV.60fps.HEVC.AAC.2.0-WF.mkv')
  expect(completedFilename(naming({ title: '一念永恒', season: 4, episode: 14, year: 2020, episodeTitle: '一念永恒 完结季 第14话' }), media({ audio: { status: 'confirmed', codec: 'eac3', channels: 2 } })))
    .toBe('一念永恒.S04E14.一念永恒.完结季.第14话.2020.2160p.TX.WEB-DL.HEVC.DDP.2.0-WF.mkv')
})

test('actual lower resolution and regular fps replace the selected 4K/60 specs', () => {
  const name = completedFilename(naming(), media({ width: 1920, height: 808, codec: 'h264', fps: 25 }))
  expect(name).toContain('.1080p.TX.WEB-DL.AVC.AAC.2.0-')
  expect(name).not.toContain('2160p')
  expect(name).not.toContain('fps')
  expect(completedFilename(naming(), media({ fps: 60000 / 1001 }), 'MAXPLUS')).toContain('.WEB-DL.MAXPLUS.60fps.HEVC.')
  expect(completedFilename(naming(), media({ fps: 50, dynamicRange: 'HLG' }))).toContain('.WEB-DL.HDR.50fps.')
  expect(completedFilename(naming({ episodeTitle: '节目' }), media())).not.toContain('.节目.2026')
})

test('portrait 4K specials name the measured resolution and keep SDR out of the suffix', () => {
  const n = naming({ title: '毛雪汪', season: 0, episode: 171, year: 2021,
    episodeTitle: '购物车：便携养生好物分享' })
  const specs = media({ width: 2160, height: 3840, fps: 60000 / 1001,
    audio: { status: 'confirmed', codec: 'eac3', channels: 2 } })
  expect(completedFilename(n, specs))
    .toBe('毛雪汪.S00E171.购物车.便携养生好物分享.2021.2160p.TX.WEB-DL.60fps.HEVC.DDP.2.0-WF.mkv')
  expect(completedFilename(n, media({ width: 1080, height: 1920, fps: 25 })))
    .toEndWith('.2021.1080p.TX.WEB-DL.HEVC.AAC.2.0-WF.mkv')
})

test('IQ movies and episodes use the platform tag and actual default audio without guessed premium markers', () => {
  const source = sourceTag('iq')
  expect(source).toBe('IQ')
  expect(completedFilename(naming({ kind: 'movie', title: '电影', source }), media({
    width: 1920, height: 808, audio: { status: 'confirmed', codec: 'eac3', channels: 6 },
  }))).toBe('电影.2026.1080p.IQ.WEB-DL.HEVC.DDP.5.1-WF.mkv')
  expect(completedFilename(naming({ title: '节目', season: 2, episode: 12, episodeTitle: '团圆', source }), media()))
    .toBe('节目.S02E12.团圆.2026.2160p.IQ.WEB-DL.HEVC.AAC.2.0-WF.mkv')
})

test('domestic IQ uses IQIYI and actual video/default audio specs for movies and specials', () => {
  const source = sourceTag('iqcn')
  expect(source).toBe('IQIYI')
  expect(completedFilename(naming({ source, season: 0, episode: 298, episodeTitle: '特别篇' }), media({
    width: 1920, height: 808, codec: 'h264', fps: 25, audio: { status: 'confirmed', codec: 'aac', channels: 2 },
  }))).toBe('节目.S00E298.特别篇.2026.1080p.IQIYI.WEB-DL.AVC.AAC.2.0-WF.mkv')
  expect(completedFilename(naming({ source, kind: 'movie', title: '电影', container: 'mp4' }), media({
    fps: 60000 / 1001, dynamicRange: 'DV', audio: { status: 'confirmed', codec: 'eac3', channels: 6 },
  }))).toBe('电影.2026.2160p.IQIYI.WEB-DL.DV.60fps.HEVC.DDP.5.1-WF.mp4')
  expect(completedFilename(naming({ source }), media({ audio: { status: 'ambiguous' } })))
    .toBe('节目.S01E01.2026.2160p.IQIYI.WEB-DL.HEVC-WF.mkv')
  expect(sourceTag('iq')).toBe('IQ')
})

test('long Chinese subtitles retain the measured suffix without creating directories', () => {
  const n = naming({ title: '超长片名'.repeat(40), episodeTitle: '标题/含反斜线\\和精彩内容'.repeat(70), container: 'mp4' })
  const result = completedFilename(n, media({ audio: { status: 'confirmed', codec: 'dts', channels: 6 } }))
  expect(Buffer.byteLength(result)).toBeLessThanOrEqual(240)
  expect(result).toContain('.S01E01.')
  expect(result).toEndWith('.2026.2160p.TX.WEB-DL.HEVC.DTS.5.1-WF.mp4')
  expect(result).not.toMatch(/[\/\\\x00-\x1f]/)
  expect(result).not.toContain('�')
})

test('domestic EDR and EDR 10bit follow the actual download-plan video ID and occupy the premium marker position', () => {
  const edr = { id: '800|200|60|edrVideo', vid: 'edrVideo', bid: 800, br: 200, fr: 60,
    name: '帧绮映画 4K · 高码率 · EDR 10bit', dynamic_range_code: 8 }
  const sdr = { ...edr, id: '800|200|60|sdrVideo', vid: 'sdrVideo', name: '4K · 高码率 · SDR 10bit', dynamic_range_code: 7 }
  const video = { bid: 800, br: 200, fr: 60, vid: 'edrVideo', segments: [{ url: 'https://cdn.example/video?SECRET' }] }
  for (const code of [4, 8, '8']) {
    const evidence = iqcnNamingEvidence({ video, formats: [sdr, { ...edr, dynamic_range_code: code }] })
    expect(evidence).toEqual({ marker: 'EDR', stream: edr.id, evidence: 'download_plan' })
    expect(JSON.stringify(evidence)).not.toContain('SECRET')
    expect(completedFilename(naming({ source: sourceTag('iqcn') }), media({ fps: 60 }), evidence.marker))
      .toBe('节目.S01E01.2026.2160p.IQIYI.WEB-DL.EDR.60fps.HEVC.AAC.2.0-WF.mkv')
    expect(completedFilename(naming({ source: sourceTag('iqcn'), kind: 'movie', title: '电影', container: 'mp4' }),
      media({ dynamicRange: 'HDR', fps: 25, audio: { status: 'confirmed', codec: 'eac3', channels: 6 } }), evidence.marker))
      .toBe('电影.2026.2160p.IQIYI.WEB-DL.EDR.HDR.HEVC.DDP.5.1-WF.mp4')
  }
  expect(iqcnNamingEvidence({ video, formats: [{ ...edr, dynamic_range_code: undefined }] }).marker).toBe('EDR')
  const downgraded = iqcnNamingEvidence({ video: { ...video, vid: 'sdrVideo' }, formats: [edr, sdr] })
  expect(downgraded).toEqual({ stream: sdr.id, evidence: 'download_plan' })
  expect(completedFilename(naming({ source: sourceTag('iqcn') }), media(), downgraded.marker)).not.toContain('.EDR.')
})

test('domestic EDR is omitted for catalog-only, ambiguous, conflicting or unknown video identity', () => {
  const edr = { id: '800|200|60|edrVideo', vid: 'edrVideo', bid: 800, br: 200, fr: 60, dynamic_range_code: 8, selected: true }
  const video = { vid: 'edrVideo', bid: 800, br: 200, fr: 60 }
  expect(iqcnNamingEvidence({ formats: [edr] })).toEqual({})
  expect(iqcnNamingEvidence({ video: { bid: 800, br: 200, fr: 60 }, formats: [edr] })).toEqual({})
  expect(iqcnNamingEvidence({ video: { ...video, vid: 'unknown' }, formats: [edr] })).toEqual({})
  expect(iqcnNamingEvidence({ video: { ...video, br: 100 }, formats: [edr] })).toEqual({})
  expect(iqcnNamingEvidence({ video, formats: [edr, { ...edr, dynamic_range_code: 7 }] })).toEqual({})
  expect(iqcnNamingEvidence({ video, formats: [{ ...edr, vid: 'conflicting' }] })).toEqual({})
  expect(iqcnNamingEvidence({ video, formats: [{ ...edr, id: '800|200|60|conflicting' }] })).toEqual({})
  expect(iqcnNamingEvidence({ video: { ...video, vid: 'https://cdn.example/SECRET' }, formats: [edr] })).toEqual({})
  expect(iqcnNamingEvidence({ video, formats: [{ ...edr, dynamic_range_code: [8] }] }).marker).toBeUndefined()
})

test('S00 folder is preserved; old tasks and other platforms do not opt into new naming', () => {
  expect(folder(naming({ season: 0 }), '/library')).toBe(join('/library', '节目 (2026)', 'Season 00'))
  expect(usesMeasuredNaming({ provider: 'tencent' })).toBe(false)
  expect(usesMeasuredNaming({ provider: 'youku', namingVersion: 1 })).toBe(true)
  expect(usesMeasuredNaming({ provider: 'iq', namingVersion: 1 })).toBe(true)
  expect(usesMeasuredNaming({ provider: 'iq' })).toBe(false)
  expect(usesMeasuredNaming({ provider: 'iqcn', namingVersion: 1 })).toBe(true)
  expect(usesMeasuredNaming({ provider: 'iqcn' })).toBe(false)
  expect(usesMeasuredNaming({ provider: 'mewatch', namingVersion: 1 })).toBe(false)
  expect(filename(naming())).toBe('节目.S01E01.2026.2160p.TX.WEB-DL.H265-WF.mkv')
})

test('HQ comes only from a unique URL-bound video stream, never the requested quality', () => {
  const url = 'https://cdn.example/video?SIGNED_SECRET'
  const data = { streams: [{ stream_type: 'cmfv4hd_dv_hq', media_type: 'video', playlist_url: url }], video: { playlist_url: url } }
  const evidence = youkuNamingEvidence(data, url)
  expect(evidence.marker).toBe('HQ')
  expect(JSON.stringify(evidence)).not.toContain('SIGNED_SECRET')
  expect(youkuNamingEvidence({ video: { playlist_url: url } }, url)).toEqual({})
  expect(youkuNamingEvidence({ streams: [...data.streams, { stream_type: 'mp4hd3', media_type: 'video', playlist_url: url }] }, url)).toEqual({})
  expect(youkuNamingEvidence({ video: { stream_type: 'mp4hd3', url } }, url).marker).toBeUndefined()
  expect(youkuNamingEvidence(data, 'https://cdn.example/fallback')).toEqual({})
})

test('MAXPLUS follows the successful address, including partial stream identity without a format ID', () => {
  const url = 'https://cdn.example/video?SECRET'
  const selected = { stream: 'maxplus', formatId: '100' }
  const initial = tencentActualVersion({ formats: [{ name: 'maxplus', id: '100', url }] }, url, 'format', selected, 'vid')
  expect(tencentNamingEvidence(initial).marker).toBe('MAXPLUS')
  const partial = tencentActualVersion({ formats: [{ name: 'maxplus', url }] }, url, 'format', selected, 'vid')
  expect(tencentNamingEvidence(partial).marker).toBe('MAXPLUS')
  const explicit = tencentActualVersion({ video: { defn: 'maxplus', url } }, url, 'default', selected, 'vid')
  expect(tencentNamingEvidence(explicit).marker).toBe('MAXPLUS')
  expect(explicit.status).toBe('unknown') // The stream is known; its numeric format ID is still unconfirmed.
  const idBound = tencentActualVersion({ video: { format_id: '100', url }, formats: [{ id: '100', name: 'maxplus' }] }, url, 'default', selected, 'vid')
  expect(tencentNamingEvidence(idBound).marker).toBe('MAXPLUS')
  const unboundCatalog = tencentActualVersion({ video: { format_id: '2', url }, formats: [{ id: '100', name: 'maxplus' }] }, url, 'default', selected, 'vid')
  expect(tencentNamingEvidence(unboundCatalog).marker).toBeUndefined()
  const downgraded = tencentActualVersion({ video: { defn: 'fhd', format_id: '2', url } }, url, 'default', selected, 'vid', 1)
  expect(tencentNamingEvidence(downgraded).marker).toBeUndefined()
  expect(tencentNamingEvidence(tencentActualVersion({}, url, 'default', selected, 'vid'))).toEqual({})
  const ambiguous = tencentActualVersion({ formats: [{ name: 'maxplus', url }, { name: 'fhd', url }] }, url, 'format', selected, 'vid')
  expect(tencentNamingEvidence(ambiguous)).toEqual({})
  const conflicting = tencentActualVersion({ formats: [{ name: 'maxplus', url }], video: { defn: 'fhd', url } }, url, 'format', selected, 'vid')
  expect(tencentNamingEvidence(conflicting)).toEqual({})
  expect(JSON.stringify(tencentNamingEvidence(initial))).not.toContain('SECRET')
})

test('reservation and rename never overwrite existing files, even if the target appears late', () => {
  const root = mkdtempSync(join(tmpdir(), 'gvs-name-'))
  try {
    const old = join(root, 'old.mkv')
    writeFileSync(old, 'existing')
    const reserved = reserveOutputPath(old)
    expect(reserved).toEndWith('.download-1.mkv')
    writeFileSync(reserved, 'new content')
    expect(() => renameCompletedFile(reserved, 'old.mkv')).toThrow()
    expect(readFileSync(old, 'utf8')).toBe('existing')
    expect(readFileSync(reserved, 'utf8')).toBe('new content')
    const target = renameCompletedFile(reserved, 'final.mkv')
    expect(readFileSync(target, 'utf8')).toBe('new content')
    expect(readdirSync(root).sort()).toEqual(['final.mkv', 'old.mkv'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('reserved collision names remain within the filename budget for partial mux outputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'gvs-long-name-'))
  try {
    const initial = join(root, '中'.repeat(77) + '.mkv')
    writeFileSync(initial, 'existing')
    const reserved = reserveOutputPath(initial)
    expect(Buffer.byteLength(basename(reserved) + '.partial')).toBeLessThanOrEqual(255)
    expect(readFileSync(initial, 'utf8')).toBe('existing')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('finalization reads specs once, archives the final path and handles probe failures/collisions nonfatally', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gvs-name-final-'))
  try {
    let calls = 0
    const file = join(root, 'old.mp4')
    writeFileSync(file, 'finished-video')
    const probe = async () => { calls++; return media() }
    const named = await finalizeCompletedName(file, naming(), {}, undefined, probe)
    expect(named.output).toEndWith('-WF.mp4')
    const actual = tencentActualVersion({}, '', 'default', {}, 'vid')
    const record = await finishedVersionRecord(named.output, actual, undefined, named.media)
    const archive = join(root, 'records.jsonl')
    saveVersionRecord(named.output, record, archive)
    expect(calls).toBe(1)
    expect(JSON.parse(readFileSync(archive, 'utf8').trim()).output).toBe(named.output)
    writeFileSync(file, 'second-video')
    const collision = await finalizeCompletedName(file, naming(), {}, undefined, probe)
    expect(collision.output).toBe(file)
    expect(collision.note).toContain('已存在')
    expect(readFileSync(named.output, 'utf8')).toBe('finished-video')
    const failed = await finalizeCompletedName(file, naming(), {}, undefined, async () => ({ status: 'unavailable' }))
    expect(failed.output).toBe(file)
    expect(failed.note).toContain('保留原文件名')
    const noAudio = await finalizeCompletedName(file, naming({ episode: 2 }), {}, undefined,
      async () => media({ audio: { status: 'ambiguous' } }))
    expect(noAudio.note).toContain('省略音频')
    expect(noAudio.output).not.toContain('AAC')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('cancellation during the optional naming stage leaves the source intact', async () => {
  const ctrl = new AbortController()
  await expect(finalizeCompletedName('/unused.mkv', naming(), {}, ctrl.signal, async () => {
    ctrl.abort('pause'); return media()
  })).rejects.toBe('pause')
})
