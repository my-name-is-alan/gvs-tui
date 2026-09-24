import type { GwClient } from './client.ts'
import type { Audio, Quality } from '../types.ts'
import { anyInt, asString, isObj } from './util.ts'

/** 黄果：网关 resolve 一条分集 → 直链 + AES-128 key（+ 拉流 headers）。 */

export const huangguoResolveInput = (id: string) => ({ id })

export type HuangguoPick = {
  url: string
  key: string
  headers: Record<string, string>
  quality: string
  why: string
}

function headerMap(value: unknown): Record<string, string> {
  if (!isObj(value)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    const text = asString(v)
    if (text) out[k] = text
  }
  return out
}

/** AES-128 密钥固定 16 字节 hex；网关只在这条直链上给出它。 */
function aesKey(value: unknown): string {
  const key = asString(value).toLowerCase().replace(/^0x/, '')
  if (!key) return ''
  if (!/^[a-f\d]{32}$/.test(key)) throw new Error('黄果未返回有效解密密钥')
  return key
}

function videoEntries(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const media = Array.isArray(data.media) ? data.media.filter(isObj) : []
  return media.filter((m) => (asString(m.type) || 'video') === 'video' && asString(m.url))
}

function qualityLabel(v: Record<string, unknown>): string {
  const label = asString(v.quality)
  if (label) return label
  const h = anyInt(v.height)
  return h > 0 ? `${h}p` : ''
}

/**
 * 从 resolve 响应里挑一条直链 + 它的 key。
 * `want` 为空时用网关已经选好的 `media[0]`（网关默认给最高可用档位）。
 */
export function pickHuangguo(
  data: Record<string, unknown>,
  want = '',
): HuangguoPick {
  const why = asString(data.error)
  const key = isObj(data.key) ? aesKey(data.key.hex) : ''
  const videos = videoEntries(data)
  const wantQ = want.toLowerCase().trim()
  if (wantQ) {
    // variants 只用于展示档位；key 只属于本次 resolve 选中的 media[0]。
    // 网关已按 quality 选过档：media[0].quality 命中就直接用，否则不静默降级。
    const chosen = videos[0]
    if (chosen && qualityLabel(chosen).toLowerCase() === wantQ) {
      return {
        url: asString(chosen.url),
        key,
        headers: headerMap(chosen.headers),
        quality: qualityLabel(chosen),
        why,
      }
    }
    throw new Error('所选黄果画质已不可用，请重新选择')
  }
  const chosen = videos[0]
  if (!chosen) return { url: '', key, headers: {}, quality: '', why }
  return {
    url: asString(chosen.url),
    key,
    headers: headerMap(chosen.headers),
    quality: qualityLabel(chosen),
    why,
  }
}

/** 下载取链：质量不匹配时宁可报错，也不混用别的档位或别的分集。 */
export async function resolveHuangguoDownload(
  cli: Pick<GwClient, 'invoke'>,
  id: string,
  quality = '',
) {
  const input: Record<string, unknown> = { ...huangguoResolveInput(id) }
  if (quality) input.quality = quality
  const picked = pickHuangguo(await cli.invoke('huangguo', 'resolve', input), quality)
  if (!picked.url) {
    throw new Error(
      picked.why ? `黄果: ${picked.why}` : `黄果没有返回播放地址 id=${id}`,
    )
  }
  return { url: picked.url, key: picked.key, headers: picked.headers }
}

/**
 * 画质列表：网关的 `variants[]` 就是这一个 master 播放列表的全部档位；
 * 没有 variants 时给一行「默认流」。黄果的音轨随视频流，没有独立音轨可勾。
 */
export function huangguoStreamOptions(data: Record<string, unknown>): {
  qualities: Quality[]
  audios: Audio[]
} {
  const picked = pickHuangguo(data)
  if (!picked.url) throw new Error(picked.why || '黄果没有可用视频地址')
  const variants = (Array.isArray(data.variants) ? data.variants : [])
    .filter(isObj)
    .filter((v) => asString(v.url))
  const seen = new Set<string>()
  const qualities: Quality[] = []
  for (const v of variants) {
    const label = qualityLabel(v)
    const id = label || 'default'
    if (!label || seen.has(id)) continue
    seen.add(id)
    const height = anyInt(v.height)
    const width = anyInt(v.width)
    qualities.push({
      id,
      label,
      title: label,
      size: 0,
      width,
      height,
      codec: asString(v.codec) || 'H264',
      drm: picked.key ? 'AES-128' : '',
      tier: height,
    })
  }
  if (!qualities.length) {
    qualities.push({
      id: '',
      label: '默认流',
      title: '默认流（网关未提供档位）',
      size: 0,
      width: 0,
      height: 0,
      codec: '',
      drm: picked.key ? 'AES-128' : '',
    })
  }
  qualities.sort((a, b) => b.height - a.height || b.width - a.width)
  const audios: Audio[] = [
    {
      id: 'embedded',
      label: picked.key ? '随视频流（AES-128 加密）' : '随视频流',
      lang: '未提供',
      codec: '',
      isDefault: true,
      selected: true,
      embedded: true,
    },
  ]
  return { qualities, audios }
}
