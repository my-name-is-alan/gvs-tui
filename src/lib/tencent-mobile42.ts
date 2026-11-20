import { spawn, spawnSync } from 'node:child_process'
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { mobile42DecodePath } from './tool-paths.ts'
import { orderedDownload, processingQueue } from './ordered-download.ts'
import { asString, isObj } from './util.ts'

export const MOBILE42_PROFILE = 'tencent-mobile42-9.04.70.32414-v3-sdd2-hevc-v1'
const MAX_SEGMENT = 32 * 1024 * 1024
const BAD_PLAN = '腾讯 mobile42 媒体声明不受支持，请同步更新网关和客户端'

/** Bind only the requested episode/definition. Device, signing and observed scene stay explicit. */
export function bindMobile42PlayInput(input: Record<string, unknown>): Record<string, unknown> {
  if (input.protocol !== 'mobile42') return input
  try {
    if (input.session_type !== 'app' || !['app_sync', 'gateway'].includes(asString(input.account_source))) throw new Error()
    const mobile: unknown = JSON.parse(asString(input.mobile))
    if (!isObj(mobile) || !isObj(mobile.Account) || !isObj(mobile.Device) || !isObj(mobile.Scene) || !isObj(mobile.Signing)) throw new Error()
    if (Object.keys(mobile.Account).some(key => key.toLowerCase() === 'cookie')) throw new Error()
    const vid = asString(input.vid) || asString(mobile.Scene.VID)
    if (!/^[A-Za-z0-9]{11}$/.test(vid)) throw new Error()
    if (asString(mobile.Scene.PreVID) && mobile.Scene.VID !== vid) throw new Error()
    const scene: Record<string, unknown> = { ...mobile.Scene, VID: vid }
    if (asString(input.defn)) scene.Defn = asString(input.defn)
    const encoded = JSON.stringify({ ...mobile, Scene: scene })
    if (Buffer.byteLength(encoded) > 128 * 1024) throw new Error()
    return { ...input, vid, mobile: encoded }
  } catch { throw new Error('腾讯 mobile42 请求配置无效；需要不含 Cookie 的同源 App 上下文') }
}

function verifiedDecoderPath(): string {
  const binary = process.env.GVS_TENCENT_MOBILE42_DECODE || mobile42DecodePath()
  try {
    const info = lstatSync(binary)
    const expected = readFileSync(`${binary}.sha256`, 'utf8').trim()
    if (!info.isFile() || info.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(expected) ||
      createHash('sha256').update(readFileSync(binary)).digest('hex') !== expected) throw new Error()
    return binary
  } catch { throw new Error('腾讯本地处理模块缺失或校验失败，请更新完整安装包') }
}

function segmentURL(value: string): string {
  try {
    const u = new URL(value)
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash || u.port) throw new Error()
    return value
  } catch { throw new Error(BAD_PLAN) }
}

/** Enumerates URLs only. The Go decoder independently validates the full KEY schedule per index. */
export function mobile42DownloadPlan(data: Record<string, unknown>, vid: string): { urls: string[]; duration: number } {
  const media = Array.isArray(data.media) ? data.media : []
  const row = media.length === 1 && isObj(media[0]) ? media[0] : undefined
  const drm = row && isObj(row.drm) ? row.drm : undefined
  const context = drm && isObj(drm.crypto_context) ? drm.crypto_context : undefined
  if (data.protocol !== 'mobile42' || data.vid !== vid || !row || !drm || !context || drm.supported !== true ||
    drm.client_profile !== MOBILE42_PROFILE || context.profile !== MOBILE42_PROFILE || context.version !== 1 ||
    context.transport !== 'chacha20_v3' || context.codec !== 'sdd_v2_hevc' ||
    (context.transport_offset_origin !== undefined && context.transport_offset_origin !== '' && context.transport_offset_origin !== 'hls_segment')) throw new Error(BAD_PLAN)
  for (const [field, size] of [['transport_key_b64', 32], ['transport_nonce_b64', 12], ['codec_key_b64', 32], ['codec_nonce_b64', 12]] as const) {
    const text = asString(context[field])
    const bytes = Buffer.from(text, 'base64')
    if (bytes.length !== size || bytes.toString('base64') !== text) throw new Error(BAD_PLAN)
  }
  const manifest = asString(data.manifest)
  if (!manifest || Buffer.byteLength(manifest) > 1 << 20) throw new Error(BAD_PLAN)
  let header = false, ended = false, pending = false, declared = false, duration = 0, protectedKey = ''
  const urls: string[] = []
  for (const raw of manifest.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.length > 2048 || ended || (!header && line !== '#EXTM3U')) throw new Error(BAD_PLAN)
    if (line === '#EXTM3U') {
      if (header) throw new Error(BAD_PLAN)
      header = true
    } else if (line.startsWith('#EXT-X-KEY:')) {
      if (pending) throw new Error(BAD_PLAN)
      const fields: Record<string, string> = {}
      const attributes = line.slice(11)
      const parts = attributes.match(/(?:[^,"]|"[^"]*")+/g) ?? []
      if (parts.join(',') !== attributes) throw new Error(BAD_PLAN)
      for (const part of parts) {
        const pair = /^([A-Z]+)=("[^"\\\r\n]*"|[^,"\\\r\n]+)$/.exec(part.trim())
        if (!pair || fields[pair[1]!] !== undefined) throw new Error(BAD_PLAN)
        fields[pair[1]!] = pair[2]!.replace(/^"|"$/g, '')
      }
      if (fields.METHOD === 'NONE' && Object.keys(fields).length === 1) { declared = true; continue }
      if (Object.keys(fields).length !== 3 || fields.METHOD !== '0E9CA2BAE3E3CCC9' || fields.KEYFORMAT !== 'com.tencent.qqlive' ||
        fields.URI !== 'data:text/plain;base64,dHhkaWQ9QTU4NEMyQ0I0NTY1M0I4NQ==' || (protectedKey && protectedKey !== fields.URI)) throw new Error(BAD_PLAN)
      protectedKey = fields.URI!
      declared = true
    } else if (line.startsWith('#EXTINF:')) {
      const value = /^#EXTINF:([^,]+),.*$/.exec(line)
      const seconds = Number(value?.[1])
      if (pending || !value || !Number.isFinite(seconds) || seconds <= 0) throw new Error(BAD_PLAN)
      duration += seconds
      pending = true
    } else if (line === '#EXT-X-ENDLIST') {
      if (pending || !urls.length) throw new Error(BAD_PLAN)
      ended = true
    } else if (line === '#EXT-X-DISCONTINUITY' || /^#EXT-X-(?:VERSION|MEDIA-SEQUENCE|TARGETDURATION):/.test(line) || line === '#EXT-X-PLAYLIST-TYPE:VOD') {
      if (pending) throw new Error(BAD_PLAN)
    } else if (line.startsWith('#EXT')) throw new Error(BAD_PLAN)
    else if (!line.startsWith('#')) {
      if (!pending || !declared || urls.length >= 4096 || /[\x00\r\t ]/.test(line)) throw new Error(BAD_PLAN)
      urls.push(segmentURL(line))
      pending = false
    }
  }
  if (!ended || !protectedKey) throw new Error(BAD_PLAN)
  return { urls, duration }
}

/** argv contains paths/VID/index only; neither keys nor the response enter process arguments or diagnostics. */
export function decodeTencentMobile42Segment(response: string, source: string, destination: string, vid: string, index: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const binary = verifiedDecoderPath()
  return new Promise((resolve, reject) => {
    const child = spawn(binary,
      ['--response', response, '--segment', source, '--output', destination, '--vid', vid, '--segment-index', String(index)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', done = false, exited = false, failure: Error | undefined
    const finish = (error?: Error) => {
      if (done) return
      if (error && !exited) { failure ||= error; child.kill(); return }
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve()
    }
    const abort = () => finish(new Error('腾讯本地分片处理已取消'))
    const timer = setTimeout(() => finish(new Error('腾讯本地分片处理超时')), 60_000)
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', () => finish(new Error('无法启动腾讯本地处理模块，请更新完整安装包')))
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure || done) return
      if (chunk.length > 4096 - Buffer.byteLength(output)) return finish(new Error('腾讯本地处理返回异常'))
      output += chunk.toString()
    })
    // Drain without copying potentially sensitive helper diagnostics into app logs.
    child.stderr.on('data', () => {})
    child.on('close', code => {
      exited = true
      if (failure) return finish(failure)
      if (code !== 0) return finish(new Error('腾讯本地分片处理失败；未生成可播放文件'))
      const receipt = /^decoded_bytes=([1-9]\d*) sha256=([a-f0-9]{64}) network_requests=0 native_runtime=false\n$/.exec(output)
      try {
        const info = lstatSync(destination)
        if (!receipt || Number(receipt[1]) > MAX_SEGMENT || !info.isFile() || info.isSymbolicLink() || info.size !== Number(receipt[1])) throw new Error()
        const bytes = readFileSync(destination)
        if (createHash('sha256').update(bytes).digest('hex') !== receipt[2]) throw new Error()
        finish()
      } catch { finish(new Error('腾讯本地分片处理返回无效')) }
    })
    if (signal?.aborted) abort()
  })
}

type Mobile42Fetch = (url: string, init: RequestInit) => Promise<Response>

async function fetchCompleteSegment(url: string, destination: string, signal: AbortSignal, fetcher: Mobile42Fetch): Promise<number> {
  const active = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, fd: number | undefined
  try {
    let current = url, response: Response | undefined
    const seen = new Set<string>()
    for (let redirects = 0; ; redirects++) {
      active.throwIfAborted()
      if (seen.has(current)) throw new Error()
      seen.add(current)
      response = await fetcher(current, { redirect: 'manual', headers: { 'User-Agent': 'qqlive', Accept: '*/*' }, signal: active })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const next = response.headers.get('location')
      await response.body?.cancel()
      if (redirects >= 4 || !next) throw new Error()
      current = segmentURL(new URL(next, current).href)
    }
    if (response.status !== 200 || !response.body || response.headers.has('content-range')) { await response.body?.cancel(); throw new Error() }
    const advertised = response.headers.get('content-length')
    const size = advertised === null ? undefined : Number(advertised)
    if (size !== undefined && (!Number.isSafeInteger(size) || size <= 0 || size > MAX_SEGMENT)) { await response.body.cancel(); throw new Error() }
    reader = response.body.getReader()
    fd = openSync(destination, 'wx', 0o600)
    let received = 0
    while (true) {
      active.throwIfAborted()
      const part = await reader.read()
      if (part.done) break
      received += part.value.length
      if (received > MAX_SEGMENT || size !== undefined && received > size) throw new Error()
      let offset = 0
      while (offset < part.value.length) offset += writeSync(fd, part.value, offset, part.value.length - offset)
    }
    if (received <= 0 || size !== undefined && received !== size) throw new Error()
    return received
  } catch {
    signal.throwIfAborted()
    throw new Error('腾讯分片下载失败或不完整，已停止；请重新取流后重试')
  } finally {
    await reader?.cancel().catch(() => undefined)
    reader?.releaseLock()
    if (fd !== undefined) closeSync(fd)
  }
}

export type Mobile42Runtime = {
  fetch?: Mobile42Fetch
  decode?: typeof decodeTencentMobile42Segment
}

type PrivateCommand = (command: string, args: string[]) => { status: number | null; stdout: string; error?: unknown }

export function privateMobile42Scratch(work: string, platform: NodeJS.Platform = process.platform,
  run: PrivateCommand = (command, args) => spawnSync(command, args, { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 16384 })): string {
  const scratch = mkdtempSync(join(work, 'tx-mobile42-'))
  try {
    if (platform === 'win32') {
      // Windows ignores POSIX mode bits. Remove inherited ACEs before writing the response.
      const identity = run('whoami.exe', ['/user', '/fo', 'csv', '/nh'])
      const sid = identity.status === 0 && !identity.error ? identity.stdout.trim().match(/^"[^"\r\n]+","(S-1(?:-\d+){2,15})"$/)?.[1] : undefined
      if (!sid || sid.length > 184) throw new Error()
      const acl = run('icacls.exe', [scratch, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/Q'])
      if (acl.error || acl.status !== 0) throw new Error()
    } else if ((lstatSync(scratch).mode & 0o777) !== 0o700) throw new Error()
    return scratch
  } catch {
    rmSync(scratch, { recursive: true, force: true })
    throw new Error('无法建立腾讯本地处理私有工作目录')
  }
}

/** One immutable play response per attempt. Any failure removes private context and incomplete output. */
export async function downloadTencentMobile42(data: Record<string, unknown>, vid: string, destination: string, work: string,
  threads: number, progress: (bytes: number, index: number, total: number) => void, signal?: AbortSignal, runtime: Mobile42Runtime = {}): Promise<void> {
  const { urls } = mobile42DownloadPlan(data, vid)
  signal?.throwIfAborted()
  if (!runtime.decode) verifiedDecoderPath()
  const scratch = privateMobile42Scratch(work)
  const response = join(scratch, 'response.json')
  let complete = false, totalBytes = 0, fd: number | undefined
  try {
    const encoded = JSON.stringify({ code: 0, data })
    if (Buffer.byteLength(encoded) > 8 << 20) throw new Error(BAD_PLAN)
    writeFileSync(response, encoded, { flag: 'wx', mode: 0o600 })
    fd = openSync(destination, 'wx', 0o600)
    const process = processingQueue(2)
    await orderedDownload({ sizes: urls.map(() => MAX_SEGMENT), threads, budget: 128 << 20, signal,
      pull: async (index, abort) => {
        const source = join(scratch, `${index}.source`), output = join(scratch, `${index}.clear`)
        try {
          const bytes = await fetchCompleteSegment(urls[index]!, source, abort, runtime.fetch ?? fetch)
          await process(() => (runtime.decode ?? decodeTencentMobile42Segment)(response, source, output, vid, index, abort), abort)
          abort.throwIfAborted()
          const info = lstatSync(output)
          if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_SEGMENT) throw new Error('腾讯分片处理大小无效')
          const result = readFileSync(output)
          if (!result.length || result.length > MAX_SEGMENT) throw new Error('腾讯分片处理大小无效')
          return { data: result, bytes }
        } finally { rmSync(source, { force: true }); rmSync(output, { force: true }) }
      },
      write: (value, index) => {
        let offset = 0
        while (offset < value.data.length) offset += writeSync(fd!, value.data, offset, value.data.length - offset)
        totalBytes += value.bytes
        progress(totalBytes, index + 1, urls.length)
      },
    })
    signal?.throwIfAborted()
    complete = true
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (!complete && fd !== undefined) rmSync(destination, { force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}
