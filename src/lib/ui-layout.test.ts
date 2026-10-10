import { expect, test } from 'bun:test'
import { demoSnapshot } from './demo'
import { displayWidth } from './text'
import { confirmationLines, episodeRanges, fitHints, qualityColumns, selectedAudioText, viewMetrics } from './ui-layout'
import { patchJob } from './jobs'
import { qualitiesFromTencentFormats, qualityCaptionText } from './quality'

test('responsive quality columns reserve readable labels and stay within the pane', () => {
  const rows = demoSnapshot('quality-tencent').qualities!
  for (const width of [58, 78, 98, 138, 198]) {
    const { pane } = viewMetrics(width + 2, 24)
    const cols = qualityColumns(pane.main, rows)
    expect(cols[0]!.width).toBeGreaterThanOrEqual(18)
    expect(cols.map(c => c.key)).toContain('codec')
    expect(cols.map(c => c.key)).toContain('size')
    expect(2 + cols.reduce((n, c) => n + c.width, 0) + (cols.length - 1) * 2).toBeLessThanOrEqual(pane.main)
  }
  expect(qualityColumns(58, rows).length).toBeLessThan(qualityColumns(98, rows).length)
})

test('requested subtitle modes have a visible column with enough room for their labels', () => {
  const rows = qualitiesFromTencentFormats(['软', '硬'].map(caption_probe => ({
    name: 'fhd', id: '3', caption_probe, persona: `default_${caption_probe}`,
  })))
  const cols = qualityColumns(98, rows)
  const caption = cols.find(col => col.key === 'caption')!
  expect(caption).toBeDefined()
  for (const row of rows) expect(displayWidth(qualityCaptionText(row.caption, row.captionProbe))).toBeLessThanOrEqual(caption.width)
  expect(2 + cols.reduce((n, c) => n + c.width, 0) + (cols.length - 1) * 2).toBeLessThanOrEqual(98)
})

test('confirmed file paths wrap without losing characters, selected audio ignores the cursor', () => {
  const snapshot = demoSnapshot('confirm-long')
  const lines = confirmationLines(snapshot.confirmation!, 58)
  expect(lines.every(line => displayWidth(line) <= 58)).toBe(true)
  expect(lines.join('')).toContain(snapshot.confirmation!.directory)
  expect(lines.join('')).toContain(snapshot.confirmation!.name)
  expect(lines).toContain('电影 · 2026')
  const withNote = confirmationLines({ ...snapshot.confirmation!, note: '封装后按实际规格补全文件名。' }, 58)
  expect(withNote.join('')).toContain('封装后按实际规格补全文件名。')
  const audio = demoSnapshot('quality-audio')
  expect(audio.audios![audio.audioIndex]!.label).toBe('DTS:X')
  expect(selectedAudioText(audio.audios!)).toBe('国语 AAC / 国语 杜比全景声')
})

test('dense selections and narrow footers retain usable summaries and help', () => {
  expect(episodeRanges([8, 1, 2, 3, 8, 5, 10, 9])).toBe('1–3、5、8–10')
  const hints = fitHints([['⏎', '继续'], ['空格', '勾选'], ['↑↓', '移动'], ['←→', '画质'], ['esc', '返回']], 58)
  expect(hints).toContainEqual(['空格', '勾选'])
  expect(hints).toContainEqual(['F1', '帮助'])
  expect(fitHints([['esc', '返回画质']], 22)).toContainEqual(['F1', '帮助'])
  expect(displayWidth(hints.map(h => h.join(' ')).join(' · '))).toBeLessThanOrEqual(58)
})

test('failed and retrying jobs retain their last processing phase', () => {
  const jobs = [{ id: 1, title: '灵境行者 E05', status: '封装', pct: 0.99, err: '', log: '' }]
  patchJob(jobs, { id: 1, status: '失败', pct: 0.99, err: '读取原始时间戳失败', log: '', done: true })
  expect((jobs[0] as any).phase).toBe('封装')
  patchJob(jobs, { id: 1, status: '失败', pct: 0.99, err: '依然失败', log: '', done: true })
  expect((jobs[0] as any).phase).toBe('封装')
})
