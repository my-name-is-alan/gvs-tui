import { test, expect } from 'bun:test'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { iqcnAudios, selectIQCNAudios, prepareIQCNAudio, downloadIQCNAudio } from './iqcn-audio.ts'
import { resolveDefaultAudioId, selectAudioTracks } from './audio-selection.ts'
import type { GwClient } from './client.ts'
import { runLogEnabled, setRunLogDisabled } from './runlog.ts'

// Same shape as the failing episode: six AIDs represent three user choices.
const duplicateCatalog = [
  { aid: 'aac-dash', name: '普通话', language_id: 1, ct: 5, bid: 300, cf: 'aac', ff: 'dash', aat: 0, amt: 0, selected: true, has_independent_files: true },
  { aid: 'dolby-amp4', name: '普通话', language_id: 1, ct: 2, bid: 500, cf: 'dolby', ff: 'amp4', aat: 0, amt: 0 },
  { aid: 'standard-dash', name: '普通话', language_id: 1, ct: 1, bid: 100, cf: 'aac', ff: 'dash', aat: 0, amt: 0 },
  { aid: 'standard-amp4', name: '普通话', language_id: 1, ct: 1, bid: 100, cf: 'aac', ff: 'amp4', aat: 0, amt: 0 },
  { aid: 'dolby-dash', name: '普通话', language_id: 1, ct: 2, bid: 500, cf: 'dolby', ff: 'dash', aat: 0, amt: 0 },
  { aid: 'aac-amp4', name: '普通话', language_id: 1, ct: 5, bid: 300, cf: 'aac', ff: 'amp4', aat: 0, amt: 0 },
]

test('DASH and AMP4 become three unique choices without transport labels', () => {
  const rows = iqcnAudios({ audios: duplicateCatalog })
  expect(rows).toHaveLength(3)
  expect(new Set(rows.map(row => row.id)).size).toBe(3)
  expect(rows.map(row => row.vid)).toEqual(['aac-amp4', 'dolby-amp4', 'standard-dash'])
  expect(rows.filter(row => row.isDefault)).toHaveLength(1)
  expect(rows.every(row => row.selected)).toBe(true)
  expect(rows.map(row => row.label).join(' ')).not.toMatch(/DASH|AMP4/i)
  const reversed = iqcnAudios({ audios: [...duplicateCatalog].reverse() })
  for (const row of rows) expect(reversed.find(candidate => candidate.id === row.id)?.vid).toBe(row.vid)
})

test('old duplicate selections bind once to current episode sources and keep one Dolby default', () => {
  const requested = duplicateCatalog.map(row => ({ id: `iqcn:${row.language_id}:${row.ct}:${row.bid}:${row.cf}`, isDefault: row.cf === 'dolby' }))
  const rows = selectIQCNAudios({ audios: duplicateCatalog.map(row => ({ ...row, aid: `next-${row.aid}` })) }, requested)
  expect(rows).toHaveLength(3)
  expect(rows.map(row => row.vid)).toEqual(['next-aac-amp4', 'next-dolby-amp4', 'next-standard-dash'])
  expect(rows.filter(row => row.isDefault).map(row => row.codec)).toEqual(['DOLBY'])
})

test('saved queues without audio choices use all tracks and the shared default priority', () => {
  const rows = selectIQCNAudios({ audios: duplicateCatalog })
  expect(rows).toHaveLength(3)
  expect(rows.filter(row => row.isDefault).map(row => row.codec)).toEqual(['DOLBY'])
  const manual = selectIQCNAudios({ audios: duplicateCatalog }, rows.map(row => ({ id: row.id, isDefault: row.codec === 'AAC' && row.id.includes(':5:') })))
  expect(manual.filter(row => row.isDefault).map(row => row.id)).toEqual(['iqcn:1:5:300:aac'])
})

test('AMP4-only audio remains selectable when the catalog omits the independent-file flag', () => {
  const rows = iqcnAudios({ audios: [duplicateCatalog[4], { ...duplicateCatalog[1], has_independent_files: true, selected: true }] })
  expect(rows).toHaveLength(1)
  expect(rows[0]!.vid).toBe('dolby-amp4')
  expect(iqcnAudios({ audios: [duplicateCatalog[1]] })[0]!.vid).toBe('dolby-amp4')
  expect(iqcnAudios({ audios: [duplicateCatalog[0], duplicateCatalog[5]] })[0]!.vid).toBe('aac-amp4')
})

test('different languages, qualities and channel/content types are not collapsed', () => {
  const base = duplicateCatalog[0]!
  const audios = [base, { ...base, aid: 'other-language', language_id: 2 }, { ...base, aid: 'other-bitrate', bid: 400 }, { ...base, aid: 'other-channel', amt: 1 }, { ...base, aid: 'description', aat: 1 }]
  expect(iqcnAudios({ audios })).toHaveLength(5)
  const ambiguous = { audios: [{ ...base, amt: 1 }, { ...base, aid: 'second', amt: 2 }] }
  expect(() => selectIQCNAudios(ambiguous, [{ id: 'iqcn:1:5:300:aac' }])).toThrow('多个不同版本')
  expect(() => selectIQCNAudios({ audios: duplicateCatalog }, [{ id: 'iqcn:2:5:300:aac' }])).toThrow('暂不提供')
})

test('prepared descriptors are reused and cannot cross plans or audio identities', async () => {
  let calls = 0
  const cli = { invoke: async () => { calls++; return { transport: 'local-audio-v1', audioId: 'selected', name: '普通话', codec: 'aac', language_id: 1, embedded: true } } } as unknown as GwClient
  const plan = await prepareIQCNAudio(cli, 'plan', 'selected')
  let extracted = 0
  await downloadIQCNAudio(cli, 'plan', 'selected', 'unused', 1, undefined, undefined, async () => { extracted++ }, plan)
  expect(calls).toBe(1)
  expect(extracted).toBe(1)
  await expect(downloadIQCNAudio(cli, 'other-plan', 'selected', 'unused', 1, undefined, undefined, async () => {}, plan)).rejects.toThrow('音轨已变更')
})

test('audio catalog retains codecs and one source default with stable episode selectors', () => {
  const audios = [
    { aid: 'a', name: '普通话', language_id: 1, ct: 1, bid: 100, cf: 'aac' },
    { aid: 'b', name: '普通话', language_id: 1, ct: 2, bid: 500, cf: 'dolby' },
    { aid: 'c', name: '普通话', language_id: 1, ct: 5, bid: 300, cf: 'aac', selected: true },
  ]
  const rows = iqcnAudios({ audios })
  expect(rows).toHaveLength(3)
  expect(rows.filter(a => a.selected).map(a => a.vid)).toEqual(['a', 'b', 'c'])
  expect(rows.filter(a => a.isDefault).map(a => a.vid)).toEqual(['c'])
  const ids = rows.filter(a => a.selected).map(a => a.id)
  expect(resolveDefaultAudioId(rows, ids)).toBe(rows[1]!.id)
  expect(selectAudioTracks(rows, ids).map(a => a.isDefault)).toEqual([false, true, false])
  expect(selectAudioTracks(rows, ids, rows[2]!.id).map(a => a.isDefault)).toEqual([false, false, true])
  expect(rows[1]!.label).toContain('DOLBY')
  expect(rows[2]!.label).toContain('高码率')
  expect(iqcnAudios({ audios: audios.map(a => ({ ...a, aid: a.aid + '-episode2' })) }).map(a => a.id)).toEqual(rows.map(a => a.id))
})

test('domestic DASH and AMP4 duplicates are one selectable track and bind to each episode plan', () => {
  const audios = [
    { aid: 'dolby-dash', name: '普通话', language_id: 1, ct: 2, bid: 500, cf: 'dolby', ff: 'dash' },
    { aid: 'dolby-amp4', name: '普通话', language_id: 1, ct: 2, bid: 500, cf: 'dolby', ff: 'amp4' },
    { aid: 'standard-amp4', name: '普通话', language_id: 1, ct: 1, bid: 100, cf: 'aac', ff: 'amp4' },
    { aid: 'high-amp4', name: '普通话', language_id: 1, ct: 5, bid: 300, cf: 'aac', ff: 'amp4' },
    { aid: 'standard-dash', name: '普通话', language_id: 1, ct: 1, bid: 100, cf: 'aac', ff: 'dash' },
    { aid: 'high-dash', name: '普通话', language_id: 1, ct: 5, bid: 300, cf: 'aac', ff: 'dash', selected: true, has_independent_files: true },
  ]
  const rows = iqcnAudios({ audios })
  expect(rows).toHaveLength(3)
  expect(new Set(rows.map(a => a.id)).size).toBe(3)
  expect(rows.map(a => a.vid)).toEqual(['dolby-amp4', 'standard-dash', 'high-amp4'])
  expect(rows.every(a => a.selected)).toBe(true)
  expect(rows.filter(a => a.isDefault).map(a => a.vid)).toEqual(['high-amp4'])
  const selected = selectAudioTracks(rows, [rows[0]!.id, rows[2]!.id])
  expect(selected.map(a => a.isDefault)).toEqual([true, false])
  expect(resolveDefaultAudioId(rows, [rows[0]!.id])).toBe(rows[0]!.id)
  const next = iqcnAudios({ audios: audios.filter(a => a.ff === 'amp4').map(a => ({ ...a, aid: a.aid + '-ep2' })) })
  expect(next.map(a => a.id)).toEqual(rows.map(a => a.id))
  expect(next.filter(a => a.id === selected[0]!.id).map(a => a.vid)).toEqual(['dolby-amp4-ep2'])
})

test('domestic deduplication keeps other languages and bitrates and merges repeated source defaults', () => {
  const rows = iqcnAudios({ audios: [
    { aid: 'same', language_id: 1, ct: 2, bid: 500, cf: 'dolby', has_independent_files: true },
    { aid: 'same', language_id: 1, ct: 2, bid: 500, cf: 'DOLBY', selected: true },
    { aid: 'other-language', language_id: 2, ct: 2, bid: 500, cf: 'dolby' },
    { aid: 'other-bitrate', language_id: 1, ct: 2, bid: 600, cf: 'dolby' },
    { aid: '', language_id: 1, ct: 1, bid: 100, cf: 'aac' },
  ] })
  expect(rows).toHaveLength(3)
  expect(rows.filter(a => a.isDefault).map(a => a.vid)).toEqual(['same'])
  expect(new Set(rows.map(a => a.id)).size).toBe(3)
})

test('audio prefers restored AMP4 descriptors over a DASH source, regardless of misleading file flags', () => {
  const rows = iqcnAudios({ audios: [
    { aid: 'dolby-amp4', language_id: 1, ct: 2, bid: 500, cf: 'dolby', ff: 'amp4', selected: true, has_independent_files: false },
    { aid: 'dolby-dash', language_id: 1, ct: 2, bid: 500, cf: 'dolby', ff: 'dash', has_independent_files: true },
  ] })
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ vid: 'dolby-amp4', isDefault: true, selected: true })
  expect(rows[0]!.id).toBe('iqcn:1:2:500:dolby')
})

test('DASH-only catalogs and distinct audio content remain intact', () => {
  const rows = selectIQCNAudios({ audios: duplicateCatalog.filter(row => row.ff === 'dash') }, [
    { id: 'iqcn:1:5:300:aac', isDefault: true }, { id: 'iqcn:1:2:500:dolby' },
  ])
  expect(rows.map(row => row.vid)).toEqual(['aac-dash', 'dolby-dash'])
  expect(rows.map(row => row.isDefault)).toEqual([true, false])
  const variants = iqcnAudios({ audios: [duplicateCatalog[0], { ...duplicateCatalog[5], amt: 1 }] })
  expect(variants).toHaveLength(2)
  expect(variants.map(row => row.vid)).toEqual(['aac-dash', 'aac-amp4'])
})

test('audio dispatcher HTTP failures keep their business code in diagnostics without exposing signed URLs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iqcn-audio-diagnostic-'))
  const previousPath = process.env.GVS_TUI_LOG_PATH, previousLog = process.env.GVS_TUI_LOG
  const logging = runLogEnabled()
  const destination = join(dir, 'audio.m4a')
  let requests = 0
  try {
    process.env.GVS_TUI_LOG_PATH = join(dir, 'run.log')
    process.env.GVS_TUI_LOG = '1'
    setRunLogDisabled(false)
    const cli = { invoke: async () => ({ transport: 'local-audio-v1', audioId: 'chosen', codec: 'aac',
      parts: [{ index: 0, dispatch: 'https://data.video.ptqy.gitv.tv/videos/v0/a.amp4?token=PRIVATE_AUDIO_SIGNATURE' }] }) } as unknown as GwClient
    await expect(downloadIQCNAudio(cli, 'plan', 'chosen', destination, 1, undefined, async () => {
      requests++
      return Response.json({ code: 'D2102', url: 'https://private.invalid/?token=SECRET' }, { status: 405 })
    })).rejects.toThrow('所选音轨分段下载失败')
    expect(requests).toBe(2)
    expect(existsSync(destination)).toBe(false)
    const log = readFileSync(process.env.GVS_TUI_LOG_PATH, 'utf8')
    expect(log).toContain('codec=aac index=0 stage=dispatch attempt=1/2 http=405 source_code=D2102')
    expect(log).toContain('attempt=2/2')
    expect(log).not.toMatch(/https?:|PRIVATE_AUDIO|SECRET|token=/)
  } finally {
    if (previousPath === undefined) delete process.env.GVS_TUI_LOG_PATH
    else process.env.GVS_TUI_LOG_PATH = previousPath
    if (previousLog === undefined) delete process.env.GVS_TUI_LOG
    else process.env.GVS_TUI_LOG = previousLog
    setRunLogDisabled(!logging)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('wrong audio identity never starts a CDN request', async () => {
  const cli = { invoke: async () => ({ transport: 'local-audio-v1', audioId: 'wrong', parts: [] }) } as unknown as GwClient
  let fetched = false
  await expect(downloadIQCNAudio(cli, 'plan', 'chosen', join(tmpdir(), 'unused-iq-audio'), 8, undefined, async () => { fetched = true; return new Response('') })).rejects.toThrow('所选音轨')
  expect(fetched).toBe(false)
})

test('dispatcher cannot redirect local audio download to another host or file', async () => {
  for (const target of ['https://example.com/videos/v0/a', 'https://audio.ptqy.gitv.tv/other']) {
    const dest = join(mkdtempSync(join(tmpdir(), 'iqcn-audio-reject-')), 'audio.m4a')
    const cli = { invoke: async () => ({ transport: 'local-audio-v1', audioId: 'chosen', parts: [{ index: 0, dispatch: 'https://data.video.ptqy.gitv.tv/videos/v0/a.amp4' }] }) } as unknown as GwClient
    let media = false
    await expect(downloadIQCNAudio(cli, 'plan', 'chosen', dest, 8, undefined, async url => {
      if (!url.startsWith('https://data.video.ptqy.gitv.tv/')) media = true
      return Response.json({ e: '0', l: target })
    })).rejects.toThrow('分段下载失败')
    expect(media).toBe(false)
    expect(existsSync(dest)).toBe(false)
  }
})

test('DASH m4s is rejected during preflight before starting any video/media download', async () => {
  const cli = { invoke: async () => ({ transport: 'local-audio-v1', audioId: 'chosen', parts: [
    { index: 0, dispatch: 'https://data.video.ptqy.gitv.tv/videos/v0/file.m4s' },
  ] }) } as unknown as GwClient
  await expect(prepareIQCNAudio(cli, 'plan', 'chosen')).rejects.toThrow('AMP4')
})

test('AMP4 gzip objects are decoded and concatenated in source order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iqcn-audio-order-')), dest = join(dir, 'audio.m4a')
  const cli = { invoke: async () => ({ transport: 'local-audio-v1', audioId: 'chosen', parts: [0, 1].map(index => ({
    index, dispatch: `https://data.video.ptqy.gitv.tv/videos/v0/${index}.amp4`,
  })) }) } as unknown as GwClient
  try {
    await downloadIQCNAudio(cli, 'plan', 'chosen', dest, 2, undefined, async url => {
      const u = new URL(url)
      if (u.hostname === 'data.video.ptqy.gitv.tv') return Response.json({ e: '0', l: `https://cdn.ptqy.gitv.tv${u.pathname}?signed=value` })
      if (u.pathname.endsWith('0.amp4')) { await Bun.sleep(20); return new Response(gzipSync(Buffer.from('first'))) }
      return new Response(Buffer.from('second'))
    })
    expect(readFileSync(dest, 'utf8')).toBe('firstsecond')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('audio failure identifies segment and HTTP status without signed URLs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iqcn-audio-http-')), dest = join(dir, 'audio.m4a')
  const cli = { invoke: async () => ({ transport: 'local-audio-v1', audioId: 'chosen', parts: [{ index: 0, dispatch: 'https://data.video.ptqy.gitv.tv/videos/v0/a.amp4?secret=value' }] }) } as unknown as GwClient
  try {
    await expect(downloadIQCNAudio(cli, 'plan', 'chosen', dest, 1, undefined, async () => new Response('', { status: 405 }))).rejects.toThrow('第 1/1 段，音轨 HTTP 405')
    expect(existsSync(dest)).toBe(false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
