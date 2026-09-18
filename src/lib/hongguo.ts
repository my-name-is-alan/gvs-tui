import type { GwClient } from './client.ts'
import { pickHongguo } from './media.ts'
import { asString } from './util.ts'

export const hongguoResolveInput = (vid: string) => ({ vid })

export async function resolveHongguoDownload(cli: Pick<GwClient, 'invoke'>, vid: string, quality = '') {
  const data = await cli.invoke('hongguo', 'resolve', hongguoResolveInput(vid))
  const picked = pickHongguo(data, vid, quality)
  if (!picked.cdn) throw new Error(picked.why ? `红果: ${picked.why}` : `红果没有 CDN  vid=${vid}`)
  let key = picked.key
  if (!key && picked.spade) {
    const result = await cli.invoke('hongguo', 'key', { spade: picked.spade })
    key = asString(result.key) || asString(result.content_key_hex)
    if (!/^[a-f\d]{32}$/i.test(key)) throw new Error('红果未返回有效解密密钥')
  }
  return { cdn: picked.cdn, key }
}
