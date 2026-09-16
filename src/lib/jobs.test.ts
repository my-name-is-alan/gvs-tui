import { expect, test } from 'bun:test'
import { jobTitle, type DlTask } from './jobs.ts'

function task(partial: Partial<DlTask>): DlTask {
  return {
    provider: 'youku',
    title: '英语版',
    series: '第九区',
    vid: 'XEN',
    season: 1,
    episode: 1,
    height: 0,
    quality: '4K',
    group: '',
    codec: '',
    tmdbId: 0,
    nameDots: '',
    year: 2009,
    plot: '',
    ...partial,
  }
}

test('movie job title uses 英语版 not E01', () => {
  expect(jobTitle(task({ kind: 'movie', edition: '英语版' }))).toBe('第九区 英语版 4K')
})

test('show job title still uses E01', () => {
  expect(jobTitle(task({}))).toBe('第九区 E01 4K')
})
