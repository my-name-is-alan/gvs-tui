import { expect, test } from 'bun:test'
import { equivalentTencentRendition } from './tencent-rendition-resolution.ts'
import { tencentSelectedPlayInput } from './tencent-quality-selection.ts'

const choice = { quality: 'maxplus', codec: '4', tencentQuality: {
  formatId: '322155', persona: 'default_硬', captionProbe: 'hard', group: 'encode' as const,
  width: 3840, height: 2160, fps: 60, hdr: 'hdr',
} }
const row = { id: '322455', name: 'maxplus', width: 3840, height: 2160, vfps: 60,
  profile: '4', hdr: 'hdr', persona: 'default_硬', caption: '', caption_probe: '硬' }

test('batch selector rebinds the unique current episode ID and preserves the original task', () => {
  const before = JSON.stringify(choice)
  const resolved = equivalentTencentRendition(choice, [row, { ...row, persona: 'default_软', caption_probe: '软' }])
  expect(resolved).toEqual({ formatId: '322455', persona: 'default_硬', captionProbe: 'hard', group: 'encode',
    width: 3840, height: 2160, fps: 60, hdr: 'hdr' })
  expect(tencentSelectedPlayInput({ ...choice, tencentQuality: resolved })).toEqual({
    defn: 'maxplus', caption: 'hard', format_id: '322455', rendition_persona: 'default_硬',
  })
  expect(JSON.stringify(choice)).toBe(before)
})

test('rebind rejects downgraded or different resolution, fps, range, codec, persona, subtitles and tier', () => {
  for (const change of [
    { width: 1920, height: 1080 }, { vfps: 25 }, { hdr: 'sdr' }, { profile: '1' },
    { persona: '2741517771455_硬' }, { caption_probe: '软' }, { caption: 'soft' }, { name: 'suhd' },
  ]) expect(equivalentTencentRendition(choice, [{ ...row, ...change }])).toBeUndefined()
})

test('incomplete legacy selection cannot authorize a replacement ID', () => {
  for (const key of ['formatId', 'persona', 'captionProbe', 'width', 'height', 'fps', 'hdr'] as const) {
    const selected = { ...choice.tencentQuality }
    delete (selected as Record<string, unknown>)[key]
    expect(equivalentTencentRendition({ ...choice, tencentQuality: selected }, [row])).toBeUndefined()
  }
  expect(equivalentTencentRendition({ ...choice, codec: '' }, [row])).toBeUndefined()
})

test('incomplete current catalog cannot prove equivalence', () => {
  for (const key of ['id', 'persona', 'caption_probe', 'width', 'height', 'vfps', 'profile'] as const) {
    const current = { ...row }
    delete (current as Record<string, unknown>)[key]
    expect(equivalentTencentRendition(choice, [current])).toBeUndefined()
  }
})

test('multiple equivalent IDs and conflicting duplicate catalog rows stay ambiguous', () => {
  expect(equivalentTencentRendition(choice, [row, { ...row, id: '322456' }])).toBeUndefined()
  expect(equivalentTencentRendition(choice, [row, { ...row, height: 1080 }])).toBeUndefined()
  expect(equivalentTencentRendition(choice, [row, { ...row }])?.formatId).toBe('322455')
})

test('gateway ignoring an available exact ID is not fixed by rebinding', () => {
  expect(equivalentTencentRendition(choice, [{ ...row, id: '322155' }])).toBeUndefined()
  expect(equivalentTencentRendition(choice, [{ ...row, id: '322155' }, row])).toBeUndefined()
})

test('canonical codec aliases and 59.94fps retain their 60fps rendition', () => {
  const expected = { ...choice, codec: 'HEVC' }
  expect(equivalentTencentRendition(expected, [{ ...row, profile: '', vencoding: 'h265', vfps: 59.94 }])?.formatId).toBe('322455')
})

test('portrait orientation and small crop differences preserve the selected resolution', () => {
  expect(equivalentTencentRendition(choice, [{ ...row, width: 2160, height: 3840 }])?.formatId).toBe('322455')
  expect(equivalentTencentRendition(choice, [{ ...row, height: 2158 }])?.formatId).toBe('322455')
})

test('replacement selector contains no catalog credentials, URLs or keys', () => {
  const resolved = equivalentTencentRendition(choice, [{ ...row, url: 'https://example.invalid/?token=private', cookie: 'private', key: 'private', fs: 12345 }])
  expect(JSON.stringify(resolved)).not.toContain('private')
  expect(Object.keys(resolved!)).toEqual(['formatId', 'persona', 'group', 'captionProbe', 'width', 'height', 'fps', 'hdr'])
})
