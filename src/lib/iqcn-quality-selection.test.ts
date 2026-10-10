import { expect, test } from 'bun:test'
import { iqcnRendition, resolveIQCNSelection, restoreIQCNSourceHints, selectedIQCNQuality } from './iqcn-quality-selection.ts'
import { iqcnOptions } from './iqcn.ts'
import type { GwClient } from './client.ts'
import type { DlTask } from './jobs.ts'

const format = (vid: string, range = 1, codec = 1, br = 300, fr = 25) => ({
  id: `800|${br}|${fr}|${vid}`, bid: 800, br, fr, codec_code: codec, dynamic_range_code: range,
})
function fixture(catalogs: Record<string, ReturnType<typeof format>[]>) {
  const calls: string[] = []
  const cli = { invoke: async (provider: string, action: string, input: Record<string, unknown>) => {
    expect([provider, action]).toEqual(['iqcn', 'probe'])
    calls.push(String(input.tvid))
    return { formats: catalogs[String(input.tvid)] ?? [] }
  } } as unknown as GwClient
  return { cli, calls }
}

test('domestic selectors persist codec, explicit SDR zero and probe origin without credentials', () => {
  const q = iqcnOptions({ formats: [format('sdr', 0)] }, 'source').qualities[0]!
  expect(JSON.parse(JSON.stringify(selectedIQCNQuality(q, 'other'))))
    .toEqual({ sourceTvid: 'source', codecCode: 1, dynamicRangeCode: 0 })
  expect(iqcnRendition({ codec_code: '', dynamic_range_code: null }, 'source'))
    .toEqual({ sourceTvid: 'source', codecCode: undefined, dynamicRangeCode: undefined })
  expect(iqcnRendition({ codec_code: false, dynamic_range_code: false }, 'source').dynamicRangeCode).toBeUndefined()
})

test('each episode matches its own DV rendition rather than the copied VID or same-tier HDR10', async () => {
  const { cli, calls } = fixture({ ep3: [format('ep3HDR', 2), format('ep3DV'), format('ep3AVC', 1, 2), format('ep3Low', 1, 1, 100), format('ep3HighFPS', 1, 1, 300, 60)] })
  expect(await resolveIQCNSelection(cli, { vid: 'ep3', quality: format('ep2DV').id,
    iqcnQuality: { sourceTvid: 'ep2', codecCode: 1, dynamicRangeCode: 1 } }))
    .toEqual({ bid: '800', br: '300', fr: '25', vid: 'ep3DV' })
  expect(calls).toEqual(['ep3'])
})

test('explicit SDR is retained and never replaced by a premium range', async () => {
  const { cli } = fixture({ ep3: [format('dv'), format('sdr', 0)] })
  expect((await resolveIQCNSelection(cli, { vid: 'ep3', quality: format('sourceSDR', 0).id,
    iqcnQuality: { sourceTvid: 'ep2', codecCode: 1, dynamicRangeCode: 0 } })).vid).toBe('sdr')
})

test('own-episode exact IDs work without migration and legacy three-field selectors remain compatible', async () => {
  const { cli, calls } = fixture({ ep2: [format('ep2DV')] })
  expect((await resolveIQCNSelection(cli, { vid: 'ep2', quality: format('ep2DV').id })).vid).toBe('ep2DV')
  expect(await resolveIQCNSelection(cli, { vid: 'ep3', quality: '800|300|25' }))
    .toEqual({ bid: '800', br: '300', fr: '25' })
  expect(calls).toEqual(['ep2'])
})

test('legacy saved batches recover a verified probe source before rebinding retry tasks', async () => {
  const tasks = ['ep2', 'ep3'].map(vid => ({ provider: 'iqcn', series: '节目', vid, quality: format('ep2DV').id }) as DlTask)
  expect(restoreIQCNSourceHints(tasks)).toBe(true)
  expect(restoreIQCNSourceHints(tasks)).toBe(false)
  expect(tasks[1]!.iqcnQuality).toEqual({ sourceTvid: 'ep2' })
  const restored = JSON.parse(JSON.stringify(tasks[1]!)) as DlTask
  const { cli, calls } = fixture({ ep2: [format('ep2DV')], ep3: [format('ep3HDR', 2), format('ep3DV')] })
  expect((await resolveIQCNSelection(cli, restored)).vid).toBe('ep3DV')
  expect(calls).toEqual(['ep3', 'ep2'])
})

test('legacy source hints ignore incomplete records and do not replace persisted variant metadata', () => {
  const valid = { provider: 'iqcn', series: '节目', vid: 'ep3', quality: format('ep2DV').id,
    iqcnQuality: { sourceTvid: 'ep2', codecCode: 1, dynamicRangeCode: 1 } } as DlTask
  expect(restoreIQCNSourceHints([{ provider: 'iqcn' } as DlTask, { ...valid, provider: 'iq' }, valid])).toBe(false)
  expect(valid.iqcnQuality).toEqual({ sourceTvid: 'ep2', codecCode: 1, dynamicRangeCode: 1 })
})

test('unverified legacy origins and incomplete variant data fail before requesting streams', async () => {
  const { cli } = fixture({ wrong: [format('wrongDV')], ep3: [format('ep3DV')] })
  await expect(resolveIQCNSelection(cli, { vid: 'ep3', quality: format('ep2DV').id })).rejects.toThrow('重新选择画质')
  await expect(resolveIQCNSelection(cli, { vid: 'ep3', quality: format('ep2DV').id,
    iqcnQuality: { sourceTvid: 'wrong' } })).rejects.toThrow('无法确认原始视频版本')
  const missing = { ...format('ep2DV'), dynamic_range_code: undefined }
  const incomplete = fixture({ ep2: [missing as unknown as ReturnType<typeof format>], ep3: [format('ep3DV')] })
  await expect(resolveIQCNSelection(incomplete.cli, { vid: 'ep3', quality: missing.id,
    iqcnQuality: { sourceTvid: 'ep2' } })).rejects.toThrow('缺少编码或动态范围依据')
})

test('missing or ambiguous per-episode versions stop rather than switch codec/range/bitrate/fps', async () => {
  const task = { vid: 'ep3', quality: format('ep2DV').id,
    iqcnQuality: { sourceTvid: 'ep2', codecCode: 1, dynamicRangeCode: 1 } }
  for (const row of [format('hdr', 2), format('avc', 1, 2), format('low', 1, 1, 100), format('fps', 1, 1, 300, 60)]) {
    const { cli } = fixture({ ep3: [row] })
    await expect(resolveIQCNSelection(cli, task)).rejects.toThrow('缺少所选')
  }
  await expect(resolveIQCNSelection(fixture({ ep3: [format('dvA'), format('dvB')] }).cli, task)).rejects.toThrow('多个相同规格')
  expect((await resolveIQCNSelection(fixture({ ep3: [format('dvA'), format('dvA')] }).cli, task)).vid).toBe('dvA')
})

test('cancellation after the catalog request prevents further probing or streams', async () => {
  const abort = new AbortController()
  const cli = { invoke: async () => { abort.abort(new Error('stopped')); return { formats: [format('ep3DV')] } } } as unknown as GwClient
  await expect(resolveIQCNSelection(cli, { vid: 'ep3', quality: format('ep2DV').id,
    iqcnQuality: { sourceTvid: 'ep2' } }, abort.signal)).rejects.toThrow('stopped')
})

test('upstream structured catalogs bind codec-only tasks to this episode without a second probe', async () => {
  const calls: string[] = []
  const cli = { invoke: async (_provider: string, _action: string, input: Record<string, unknown>) => {
    calls.push(String(input.tvid))
    return { tvid: 'current', formats: [{ bid: 800, br: 300, fr: 25, vid: 'currentDV', codec_code: 1 }] }
  } } as unknown as GwClient
  expect(await resolveIQCNSelection(cli, { vid: 'current', quality: '800|300|25|previousDV', codec: 'H265' }))
    .toEqual({ bid: '800', br: '300', fr: '25', vid: 'currentDV' })
  expect(calls).toEqual(['current'])
})

test('codec-only upstream fallback cannot pick between HDR and DV or substitute another codec', async () => {
  const task = { vid: 'current', quality: '800|300|25|previousDV', codec: 'HEVC' }
  for (const formats of [
    [format('currentHDR', 2), format('currentDV')].map(row => ({ ...row, vid: row.id.split('|')[3] })),
    [{ bid: 800, br: 300, fr: 25, vid: 'currentAVC', codec_code: 2 }],
  ]) {
    const cli = { invoke: async () => ({ formats }) } as unknown as GwClient
    await expect(resolveIQCNSelection(cli, task)).rejects.toThrow('请单独选择')
  }
})

test('persisted local range evidence still controls upstream structured rows', async () => {
  const formats = [1, 2].map(range => ({ bid: 800, br: 300, fr: 25,
    vid: range === 1 ? 'currentDV' : 'currentHDR', codec_code: 1, dynamic_range_code: range }))
  const cli = { invoke: async () => ({ tvid: 'current', formats }) } as unknown as GwClient
  expect((await resolveIQCNSelection(cli, { vid: 'current', quality: '800|300|25|previousDV', codec: 'HEVC',
    iqcnQuality: { sourceTvid: 'previous', codecCode: 1, dynamicRangeCode: 1 } })).vid).toBe('currentDV')
})

test('a catalog for another episode is rejected even if the copied selector is present', async () => {
  const cli = { invoke: async () => ({ tvid: 'wrong', formats: [format('copiedDV')] }) } as unknown as GwClient
  await expect(resolveIQCNSelection(cli, { vid: 'current', quality: format('copiedDV').id })).rejects.toThrow('其他集')
})
