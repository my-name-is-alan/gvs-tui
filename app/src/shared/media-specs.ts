/** 画质 / 音轨卡片上的规格文字。纯函数，便于测试。 */

/** 分辨率档位名：4K / 2K / 1080P / 720P / 540P / 480P */
export function resolutionTier(height: number, width = 0): string {
  if (height >= 2000 || width >= 3600) return '4K'
  if (height >= 1400) return '2K'
  if (height >= 1000) return '1080P'
  if (height >= 700) return '720P'
  if (height >= 500) return '540P'
  if (height > 0) return `${height}P`
  return '—'
}

const VCODEC: Array<[RegExp, string]> = [
  [/bytevc2|h\.?266|vvc/i, 'H.266'], [/av1|av01/i, 'AV1'], [/hevc|h\.?265|hvc1|hev1|bytevc1/i, 'H.265'], [/avc|h\.?264/i, 'H.264'],
]
export function videoCodec(...texts: Array<string | undefined>): string {
  const t = texts.filter(Boolean).join(' ')
  for (const [re, name] of VCODEC) if (re.test(t)) return name
  return ''
}

/** HDR 类型：杜比视界 / HDR10 / HDR Vivid / HDR；SDR 或未知返回空串 */
export function hdrKind(...texts: Array<string | undefined>): string {
  const t = texts.filter(Boolean).join(' ').toLowerCase()
  if (/dolby\s*vision|dolbyvision|dvhe|dvh1|dovi|(^|[\s_|])dv([\s_|]|$)|杜比视界/.test(t)) return '杜比视界'
  if (/hdr10/.test(t)) return 'HDR10'
  if (/vivid|菁彩/.test(t)) return 'HDR Vivid'
  if (/hdr|(^|[\s_|])pq([\s_|]|$)|hlg/.test(t)) return 'HDR'
  return ''
}

/** 声道：7.1 / 5.1 / 2.0 / 全景声；识别不出返回空串 */
export function audioChannels(...texts: Array<string | undefined>): string {
  const t = texts.filter(Boolean).join(' ')
  if (/atmos|全景声/i.test(t)) return '全景声'
  const m = /(?<![\d.])([257])\.([01])(?![\d])/.exec(t)
  if (m) return `${m[1]}.${m[2]}`
  if (/立体声|stereo/i.test(t)) return '2.0'
  if (/单声道|mono/i.test(t)) return '1.0'
  return ''
}

const ACODEC: Array<[RegExp, string]> = [
  [/dts[\s:-]*x\b/i, 'DTS:X'], [/dts[\s-]*hd/i, 'DTS-HD'], [/dts/i, 'DTS'], [/atmos|全景声/i, 'Dolby Atmos'],
  [/e-?ac-?3|ec-?3|ddp|dd\+|dolby\s*digital\s*plus/i, 'E-AC-3'], [/(?<![e-])ac-?3/i, 'AC-3'], [/杜比|dolby/i, 'Dolby'],
  [/flac/i, 'FLAC'], [/opus/i, 'Opus'], [/aac|mp4a/i, 'AAC'],
]
export function audioCodec(...texts: Array<string | undefined>): string {
  const t = texts.filter(Boolean).join(' ')
  for (const [re, name] of ACODEC) if (re.test(t)) return name
  return ''
}
