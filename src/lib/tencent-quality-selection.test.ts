import { expect, test } from 'bun:test'
import { selectedTencentQuality, tencentDownloadSelection, tencentSelectedPlayInput } from './tencent-quality-selection.ts'
import type { Quality } from '../types.ts'

const q: Quality = { id: 'suhd|hard|322157|2741517771455_硬', stream: 'suhd', caption: 'hard', formatId: '322157', persona: '2741517771455_硬', group: 'encode', label: '臻彩MAX · HEVC·A', title: 'suhd', width: 3840, height: 1636, size: 1128670539, codec: '4', drm: '' }

test('selected HEVC identity survives persistence while play uses compatible parameters', () => {
  const task = JSON.parse(JSON.stringify({ quality: q.stream, caption: q.caption, group: 'WF', tencentQuality: selectedTencentQuality(q) }))
  expect(task.tencentQuality).toEqual({ formatId: '322157', persona: '2741517771455_硬', group: 'encode' })
  expect(tencentSelectedPlayInput(task)).toEqual({ defn: 'suhd', caption: 'hard' })
  expect(tencentDownloadSelection(task)).toEqual({ stream: 'suhd', caption: 'hard', formatId: '322157' })
  expect(tencentSelectedPlayInput(task).encode).toBeUndefined()
})

test('legacy task without saved selectors keeps its previous request', () => {
  expect(tencentSelectedPlayInput({ quality: 'uhd', caption: 'soft', group: 'WF' })).toEqual({ defn: 'uhd', caption: 'soft' })
  expect(tencentDownloadSelection({ quality: 'uhd' })).toEqual({ stream: 'uhd', caption: undefined, formatId: undefined })
})

test('composite identities and Chinese captions remain usable', () => {
  expect(tencentSelectedPlayInput({ quality: q.id })).toEqual({ defn: 'suhd', caption: 'hard' })
  expect(tencentSelectedPlayInput({ quality: 'fhd', caption: '软字幕', persona: 'h264_软', formatId: '321004' })).toEqual({ defn: 'fhd', caption: 'soft' })
})

test('special personas and source hints do not add unsupported play parameters', () => {
  expect(tencentSelectedPlayInput({ quality: 'maxplus', persona: 'l3_hard' })).toEqual({ defn: 'maxplus' })
  expect(tencentSelectedPlayInput({ quality: 'source', tencentQuality: { group: 'source' } })).toEqual({ defn: 'source' })
  expect(selectedTencentQuality({ id: 'uhd|hard|0|main' })).toBeUndefined()
})
