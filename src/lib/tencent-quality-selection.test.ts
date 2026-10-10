import { expect, test } from 'bun:test'
import { selectedTencentQuality, tencentDownloadSelection, tencentSelectedPlayInput } from './tencent-quality-selection.ts'
import type { Quality } from '../types.ts'
import { qualitiesFromTencentFormats, qualityCaptionText, qualityChoiceLabel } from './quality.ts'
import { pickTencentDownloadURL } from './media.ts'

test('unknown subtitle display retains the soft probe for selection and queued downloads', () => {
  const [quality] = qualitiesFromTencentFormats([{ name: 'fhd', id: '3', caption_probe: '软' }])
  expect(quality!.caption).toBeUndefined()
  expect(qualityCaptionText(quality!.caption)).toBe('')
  expect(qualityCaptionText(quality!.caption, quality!.captionProbe)).toBe('软字幕')
  expect(qualityChoiceLabel(quality!)).toBe('FHD · 软字幕')
  expect(tencentSelectedPlayInput(quality!)).toEqual({ defn: 'fhd', caption: 'soft', format_id: '3' })
  const task = JSON.parse(JSON.stringify({ quality: quality!.stream, tencentQuality: selectedTencentQuality(quality!) }))
  expect(tencentSelectedPlayInput(task)).toEqual({ defn: 'fhd', caption: 'soft', format_id: '3' })
  expect(pickTencentDownloadURL({ formats: [
    { name: 'fhd', id: '3', caption_probe: '硬', url: 'https://example.invalid/hard' },
    { name: 'fhd', id: '3', caption_probe: '软', url: 'https://example.invalid/soft' },
  ] }, { stream: 'fhd', formatId: '3', caption: 'soft' })).toBe('https://example.invalid/soft')
})

test('unconfirmed soft and hard catalog rows have distinct labels and retain exact download selectors', () => {
  const rows = qualitiesFromTencentFormats(['软', '硬'].map(caption_probe => ({
    name: 'maxplus', id: '322152', sname: '臻彩MAX+', caption: '', caption_probe,
    persona: `2741527771455_${caption_probe}`, width: 3840, height: 1604, vfps: 60,
  })))
  expect(rows.map(qualityChoiceLabel)).toEqual([
    '臻彩MAX+ · HEVC·B · HDR · 60fps · 软字幕',
    '臻彩MAX+ · HEVC·B · HDR · 60fps · 硬字幕',
  ])
  for (const [index, row] of rows.entries()) {
    expect(row.caption).toBeUndefined()
    const expected = { defn: 'maxplus', caption: index ? 'hard' : 'soft',
      format_id: '322152', rendition_persona: index ? '2741527771455_硬' : '2741527771455_软' }
    expect(tencentSelectedPlayInput(row)).toEqual(expected)
    const task = JSON.parse(JSON.stringify({ quality: row.stream, tencentQuality: selectedTencentQuality(row) }))
    expect(tencentSelectedPlayInput(task)).toEqual(expected)
  }
})

test('confirmed subtitles take display precedence and missing subtitle evidence stays unknown', () => {
  const [confirmed, unknown] = qualitiesFromTencentFormats([
    { name: 'fhd', id: '3', caption: 'soft', caption_probe: '硬' },
    { name: 'fhd', id: '4', caption: 'unknown', caption_probe: 'unknown' },
  ])
  expect(qualityChoiceLabel(confirmed!)).toBe('FHD · 软字幕')
  expect(tencentSelectedPlayInput(confirmed!).caption).toBe('hard')
  expect(unknown!.captionProbe).toBeUndefined()
  expect(qualityChoiceLabel(unknown!)).toBe('FHD')
})

const q: Quality = { id: 'suhd|hard|322157|2741517771455_硬', stream: 'suhd', caption: 'hard', formatId: '322157', persona: '2741517771455_硬', group: 'encode', label: '臻彩MAX · HEVC·A', title: 'suhd', width: 3840, height: 1636, size: 1128670539, codec: '4', drm: '' }

test('selected HEVC identity survives persistence while play uses compatible parameters', () => {
  const task = JSON.parse(JSON.stringify({ quality: q.stream, caption: q.caption, group: 'WF', tencentQuality: selectedTencentQuality(q) }))
  expect(task.tencentQuality).toEqual({ formatId: '322157', persona: '2741517771455_硬', captionProbe: 'hard', group: 'encode', width: 3840, height: 1636 })
  expect(tencentSelectedPlayInput(task)).toEqual({ defn: 'suhd', caption: 'hard', format_id: '322157', rendition_persona: '2741517771455_硬' })
  expect(tencentDownloadSelection(task)).toEqual({ stream: 'suhd', caption: 'hard', formatId: '322157' })
  expect(tencentSelectedPlayInput(task).encode).toBeUndefined()
})

test('legacy task without saved selectors keeps its previous request', () => {
  expect(tencentSelectedPlayInput({ quality: 'uhd', caption: 'soft', group: 'WF' })).toEqual({ defn: 'uhd', caption: 'soft' })
  expect(tencentDownloadSelection({ quality: 'uhd' })).toEqual({ stream: 'uhd', caption: undefined, formatId: undefined })
})

test('composite identities and Chinese captions remain usable', () => {
  expect(tencentSelectedPlayInput({ quality: q.id })).toEqual({ defn: 'suhd', caption: 'hard', format_id: '322157', rendition_persona: '2741517771455_硬' })
  expect(tencentSelectedPlayInput({ quality: 'fhd', caption: '软字幕', persona: 'h264_软', formatId: '321004' })).toEqual({ defn: 'fhd', caption: 'soft', format_id: '321004', rendition_persona: 'h264_软' })
})

test('special personas and source hints do not add unsupported play parameters', () => {
  expect(tencentSelectedPlayInput({ quality: 'maxplus', persona: 'l3_hard' })).toEqual({ defn: 'maxplus' })
  expect(tencentSelectedPlayInput({ quality: 'source', tencentQuality: { group: 'source' } })).toEqual({ defn: 'source' })
  expect(selectedTencentQuality({ id: 'uhd|hard|0|main' })).toBeUndefined()
})

test('legacy catalog without format IDs still retains promised HDR and frame rate', () => {
  expect(selectedTencentQuality({ id: 'maxplus', width: 3840, height: 2160, fps: 60, hdr: 'hdr' })).toMatchObject({ width: 3840, height: 2160, fps: 60, hdr: 'hdr' })
})
