import { expect, test } from 'bun:test'
import { defaultAudioIndex, orderedMuxAudios, resolveDefaultAudioId, selectAudioTracks } from './audio-selection.ts'

const pool = [
  { id: 'mandarin', label: 'AAC', lang: '普通话', isDefault: true },
  { id: 'min', label: 'AAC', lang: 'min', isDefault: false },
  { id: 'minnan', label: 'AAC', lang: '闽南', isDefault: false },
]

test('a chosen language overrides the provider default without dropping other audio', () => {
  const tracks = selectAudioTracks(pool, pool.map(a => a.id), 'minnan')
  expect(tracks.map(a => a.id)).toEqual(['mandarin', 'min', 'minnan'])
  expect(tracks.map(a => a.isDefault)).toEqual([false, false, true])
  expect(pool[0]!.isDefault).toBe(true)
  expect(tracks[0]).not.toBe(pool[0])
  // The persisted job carries the same choice when it is resumed.
  expect(defaultAudioIndex(JSON.parse(JSON.stringify(tracks)))).toBe(2)
})

test('unselected or vanished defaults fall back to a selected track', () => {
  expect(resolveDefaultAudioId(pool, ['min', 'minnan'], 'mandarin')).toBe('min')
  expect(resolveDefaultAudioId(pool, ['mandarin', 'min'], 'minnan')).toBe('mandarin')
  expect(selectAudioTracks(pool, ['min', 'minnan']).map(a => a.isDefault)).toEqual([true, false])
  expect(selectAudioTracks(pool, []).map(a => a.id)).toEqual(['mandarin'])
  expect(selectAudioTracks(pool.map(a => ({ ...a, isDefault: false })), []).map(a => a.id)).toEqual(['mandarin'])
})

const tiers = [
  { id: 'V|cmfa1hd3', label: 'AAC', codec: 'AAC', isDefault: true },
  { id: 'V|cmfa3hd5', label: 'DTS 5.1', codec: 'DTS', isDefault: false },
  { id: 'V|cmfa4hd4_51', label: '杜比 5.1', codec: 'E-AC-3', isDefault: false },
]
const allTiers = tiers.map(a => a.id)

test('automatic default prefers DTS 5.1 over DDP even when the provider defaults to AAC', () => {
  expect(resolveDefaultAudioId(tiers, allTiers)).toBe(tiers[1]!.id)
  expect(selectAudioTracks(tiers, allTiers).map(a => a.isDefault)).toEqual([false, true, false])
  expect(selectAudioTracks(tiers, []).map(a => a.id)).toEqual([tiers[1]!.id])
  expect(resolveDefaultAudioId(tiers, allTiers.slice(0, 2))).toBe(tiers[1]!.id)
  expect(resolveDefaultAudioId(tiers, [tiers[0]!.id, tiers[2]!.id])).toBe(tiers[2]!.id)
  expect(resolveDefaultAudioId(tiers, [tiers[0]!.id])).toBe(tiers[0]!.id)
})

test('a manual audio choice wins over DTS until it is deselected', () => {
  expect(resolveDefaultAudioId(tiers, allTiers, tiers[0]!.id)).toBe(tiers[0]!.id)
  expect(selectAudioTracks(tiers, allTiers, tiers[0]!.id).map(a => a.isDefault)).toEqual([true, false, false])
  expect(resolveDefaultAudioId(tiers, allTiers, tiers[2]!.id)).toBe(tiers[2]!.id)
  expect(selectAudioTracks(tiers, allTiers, tiers[2]!.id).map(a => a.isDefault)).toEqual([false, false, true])
  expect(resolveDefaultAudioId(tiers, allTiers.slice(1), tiers[0]!.id)).toBe(tiers[1]!.id)
  // Adding a higher tier while still in automatic mode recomputes the default.
  expect(resolveDefaultAudioId(tiers, [tiers[0]!.id])).toBe(tiers[0]!.id)
  expect(resolveDefaultAudioId(tiers, allTiers)).toBe(tiers[1]!.id)
})

test('equal tiers keep the probe language order and codec-only tracks are recognized', () => {
  expect(resolveDefaultAudioId(pool, pool.map(a => a.id))).toBe('mandarin')
  const codecOnly = [
    { id: '1', codec: 'AAC', isDefault: true },
    { id: '2', codec: 'DTS' },
    { id: '3', codec: 'E-AC-3' },
  ]
  expect(resolveDefaultAudioId(codecOnly, ['1', '2', '3'])).toBe('2')
  expect(resolveDefaultAudioId([{ id: 'embedded', codec: 'Atmos', embedded: true }, ...codecOnly], ['embedded', '1', '2', '3'])).toBe('2')
})

test('DTS:X and provider DTS IDs also take priority over Atmos', () => {
  const atmos = { id: 'V|cmfa4hd5_atmos51', label: '杜比全景声', codec: 'Atmos' }
  for (const dts of [
    { id: 'dtsx', label: 'DTS:X 5.1' },
    { id: 'V|cmfa3hd5', label: '音轨' },
  ]) {
    expect(resolveDefaultAudioId([atmos, dts], [atmos.id, dts.id])).toBe(dts.id)
  }
})

test('an explicit output default must belong to the selected separate audio', () => {
  expect(() => selectAudioTracks(pool, ['mandarin'], 'minnan')).toThrow('默认音轨必须是已选音轨')
  expect(() => selectAudioTracks(pool, ['mandarin'], 'gone')).toThrow('默认音轨必须是已选音轨')
  const embedded = [{ id: 'embedded', isDefault: true, embedded: true }]
  expect(selectAudioTracks(embedded, ['embedded'])).toEqual([])
  expect(resolveDefaultAudioId(embedded, ['embedded'])).toBe('')
})

test('only one available audio becomes the mux default, including older tasks and missing tracks', () => {
  expect(defaultAudioIndex([{ isDefault: false }, { isDefault: true }, { isDefault: false }])).toBe(1)
  expect(defaultAudioIndex([{ isDefault: false }, { isDefault: false }])).toBe(0)
  expect(defaultAudioIndex([{}, {}])).toBe(0)
  expect(defaultAudioIndex([{ isDefault: true }, { isDefault: true }])).toBe(0)
})

test('mux puts the selected default first and preserves all other languages and their relative order', () => {
  const selected = selectAudioTracks(pool, pool.map(a => a.id), 'minnan')
  const saved = JSON.parse(JSON.stringify(selected))
  const ordered = orderedMuxAudios(selected)
  expect(ordered.map(a => [a.id, a.lang, a.isDefault])).toEqual([
    ['minnan', '闽南', true], ['mandarin', '普通话', false], ['min', 'min', false],
  ])
  expect(selected).toEqual(saved)
  expect(ordered.every(a => !selected.includes(a))).toBe(true)
  expect(orderedMuxAudios(JSON.parse(JSON.stringify(selected)))).toEqual(ordered)
})

test('mux ordering follows the chosen default, including automatic DDP and manually selected AAC', () => {
  const ids = [tiers[0]!.id, tiers[2]!.id]
  expect(orderedMuxAudios(selectAudioTracks(tiers, ids)).map(a => a.codec)).toEqual(['E-AC-3', 'AAC'])
  expect(orderedMuxAudios(selectAudioTracks(tiers, allTiers)).map(a => a.codec)).toEqual(['DTS', 'AAC', 'E-AC-3'])
  expect(orderedMuxAudios(selectAudioTracks(tiers, allTiers, tiers[0]!.id)).map(a => a.codec)).toEqual(['AAC', 'DTS', 'E-AC-3'])
})

test('mux keeps a deterministic first default for old queues without changing their source flags', () => {
  const missing: Array<{ id: string; isDefault?: boolean }> = [{ id: 'a' }, { id: 'b' }]
  expect(orderedMuxAudios(missing)).toEqual([{ id: 'a', isDefault: true }, { id: 'b', isDefault: false }])
  expect(missing).toEqual([{ id: 'a' }, { id: 'b' }])
  expect(orderedMuxAudios([{ id: 'a' }, { id: 'b', isDefault: true }, { id: 'c', isDefault: true }]))
    .toEqual([{ id: 'b', isDefault: true }, { id: 'a', isDefault: false }, { id: 'c', isDefault: false }])
  expect(orderedMuxAudios([])).toEqual([])
})
