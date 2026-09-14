import { writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

function xmlTag(name: string, v: string): string {
  const safe = v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return `  <${name}>${safe}</${name}>\n`
}

export function writeTvShowNFO(dir: string, title: string, plot: string, tmdbId: number): void {
  let b = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<tvshow>\n'
  b += xmlTag('title', title)
  if (plot) b += xmlTag('plot', plot)
  if (tmdbId > 0) b += `  <uniqueid type="tmdb" default="true">${tmdbId}</uniqueid>\n`
  b += '</tvshow>\n'
  writeFileSync(join(dir, 'tvshow.nfo'), b)
}

export function writeEpisodeNFO(mediaPath: string, title: string, season: number, ep: number, plot: string): void {
  let b = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<episodedetails>\n'
  b += xmlTag('title', title)
  if (season > 0) b += xmlTag('season', String(season))
  if (ep > 0) b += xmlTag('episode', String(ep))
  if (plot) b += xmlTag('plot', plot)
  b += '</episodedetails>\n'
  writeFileSync(mediaPath.slice(0, mediaPath.length - extname(mediaPath).length) + '.nfo', b)
}
