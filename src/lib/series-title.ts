export type SeriesTitle = { title: string; season?: number }

function seasonNumber(value: string): number {
  if (/^\d+$/.test(value)) return Number(value)
  const digits = '零一二三四五六七八九'
  const number = (text: string) => digits.indexOf(text.replace(/〇/g, '零').replace(/两|兩/g, '二'))
  if (value === '十') return 10
  if (/^[一二三四五六七八九两兩]?十[一二三四五六七八九]?$/.test(value)) {
    const [tens, ones] = value.split('十')
    return (tens ? number(tens) : 1) * 10 + (ones ? number(ones) : 0)
  }
  return value.length === 1 ? number(value) : 0
}

/** A trailing season label belongs to the TV season, not TMDB's series title.
 * Keep sequel numbers, episode numbers and season words inside a real title. */
export function parseSeriesTitle(value: string): SeriesTitle {
  const title = value.trim()
  const normalized = title.normalize('NFKC')
  const chinese = normalized.match(/[\s·•:：\-–—]*[([【]?\s*第\s*([\d零〇一二三四五六七八九十两兩]+)\s*季\s*[)\]】]?$/)
  const english = normalized.match(/(?:[\s·•:：\-–—]+|\s*[(\[【]\s*)(?:season\s*(\d{1,3})|s(\d{1,3}))\s*[)\]】]?$/i)
  const match = chinese ?? english
  if (!match || match.index === undefined) return { title }
  const season = seasonNumber(match[1] || match[2] || '')
  const base = normalized.slice(0, match.index).trim()
  if (!base || season < 1 || season > 999) return { title }
  return { title: base, season }
}

/** Explicit episode metadata wins; titles fill gaps before the historical S01 default. */
export function seriesSeason(season: number | undefined, title: string): number {
  return season && Number.isSafeInteger(season) && season > 0 ? season : parseSeriesTitle(title).season ?? 1
}
