import { CdnDenied } from './media.ts'
import { sleep } from './util.ts'
import { HlsRefreshError } from './hls-relay.ts'

export const CDN_REFRESH_RETRIES = 5

/** Each retry must fetch fresh URLs/keys, not reuse the rejected playlist. */
export async function retryCdnRefresh<T>(
  operation: () => Promise<T>,
  note?: (retry: number, total: number, delayMs: number, status: number) => void,
  wait: (ms: number) => Promise<unknown> = sleep,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation() }
    catch (e) {
      if (e instanceof HlsRefreshError) throw e
      const message = e instanceof Error ? e.message : String(e)
      const status = e instanceof CdnDenied ? e.status
        : Number(message.match(/\b(403|410)\b/)?.[1] ?? (/\bForbidden\b/i.test(message) ? 403 : 0))
      if (status !== 403 && status !== 410) throw e
      if (attempt >= CDN_REFRESH_RETRIES) {
        throw new Error(`重新取链重试 ${CDN_REFRESH_RETRIES} 次后 CDN 仍返回 ${status}，下载已停止；请检查该片源的播放权限或稍后重试`, { cause: e })
      }
      const delayMs = Math.min(2000 * 2 ** attempt, 12000)
      note?.(attempt + 1, CDN_REFRESH_RETRIES, delayMs, status)
      await wait(delayMs)
    }
  }
}
