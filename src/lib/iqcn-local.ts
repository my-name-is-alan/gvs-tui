import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GwClient } from './client.ts'
import { iqcnLocalPath } from './tool-paths.ts'
import { asString, isObj } from './util.ts'
import { iqcnSegmentDescriptor } from './iqcn-control.ts'

export type IQCNProcessing = { version: number; ticket: string; identity: string }
type LocalResult = { version: number; bytes: number; restored: boolean; clearCandidate: boolean }
export type IQCNLocalRuntime = {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  restore: (source: string, destination: string, material: IQCNProcessing, signal?: AbortSignal) => Promise<LocalResult>
}
const MAX_SEGMENT = 64 * 1024 * 1024

/** Only fixed messages emitted by our helper may enter diagnostics. */
export function iqcnRestoreReason(stderr: string): string {
  const reasons: Record<string, string> = {
    'invalid local processing material': 'material_invalid',
    'local segment restoration failed': 'restore_failed',
    'local segment restoration incomplete': 'restore_incomplete',
    'cannot open local segment': 'input_open_failed',
    'local segment exceeds size limit or cannot be read': 'input_read_failed',
    'cannot create local output': 'output_create_failed',
    'cannot write local output': 'output_write_failed',
  }
  return reasons[stderr.trim()] ?? 'helper_failed'
}

export function iqcnProcessing(plan: Record<string, unknown>): IQCNProcessing {
  const value = isObj(plan.localProcessing) ? plan.localProcessing : {}
  if (plan.transport !== 'local-v1' || value.version !== 1 || !asString(value.ticket) || !asString(value.identity)) {
    throw new Error('爱奇艺国内版网关未提供本地下载协议，请同步更新网关和 App')
  }
  return { version: 1, ticket: asString(value.ticket), identity: asString(value.identity) }
}

function mediaURL(raw: unknown): string {
  const text = asString(raw)
  let u: URL
  try { u = new URL(text) } catch { throw new Error('分片地址无效') }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || !u.hostname.endsWith('.ptqy.gitv.tv')) {
    throw new Error('分片地址不属于爱奇艺 CDN')
  }
  return text
}

// Fetch uses the local Node/Bun transport, never GwClient or the tunnel.
async function fetchSegment(url: string, destination: string, size: number, fetcher: IQCNLocalRuntime['fetch'], signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(60_000)
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout
  let fd: number | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    active.throwIfAborted()
    const response = await fetcher(url, { redirect: 'manual', signal: active })
    if (![200, 206].includes(response.status) || !response.body) {
      await response.body?.cancel()
      throw new Error(`HTTP ${response.status}`)
    }
    const advertised = response.headers.get('content-length')
    if (advertised !== null && Number(advertised) !== size) {
      await response.body.cancel()
      throw new Error('分片长度不符')
    }
    reader = response.body.getReader()
    fd = openSync(destination, 'w', 0o600)
    let received = 0
    while (true) {
      active.throwIfAborted()
      const part = await reader.read()
      if (part.done) break
      received += part.value.byteLength
      if (received > size) throw new Error('分片超出声明长度')
      let offset = 0
      while (offset < part.value.length) offset += writeSync(fd, part.value, offset, part.value.length - offset)
    }
    if (received !== size) throw new Error('分片下载不完整')
  } catch (error) {
    signal?.throwIfAborted()
    if (timeout.aborted) throw new Error('分片直连超时')
    // Do not expose signed URLs from network exceptions.
    const message = error instanceof Error ? error.message : ''
    throw new Error(/^(HTTP \d+|分片)/.test(message) ? message : '分片直连连接失败')
  } finally {
    await reader?.cancel().catch(() => undefined)
    reader?.releaseLock()
    if (fd !== undefined) closeSync(fd)
  }
}

export function restoreIQCNLocal(source: string, destination: string, material: IQCNProcessing, signal?: AbortSignal): Promise<LocalResult> {
  signal?.throwIfAborted()
  const binary = process.env.GVS_IQCN_LOCAL || iqcnLocalPath()
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', diagnostic = '', done = false
    let failure: Error | undefined
    let exited = false
    const finish = (err?: Error, value?: LocalResult) => {
      if (done) return
      if (err && !exited) {
        failure ||= err
        child.kill()
        // Wait for close before the caller removes files or frees a CPU slot.
        return
      }
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (err) reject(err)
      else resolve(value!)
    }
    const abort = () => finish(new Error('本地分片处理已取消'))
    const timer = setTimeout(() => finish(new Error('本地分片处理超时')), 60_000)
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', () => finish(new Error('无法启动爱奇艺本地处理模块，请更新完整 App 安装包')))
    child.stdin.on('error', () => finish(new Error('本地分片处理输入失败')))
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (output.length > 4096) finish(new Error('本地分片处理返回异常'))
    })
    child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(0, 4096) })
    child.on('close', code => {
      exited = true
      if (failure) return finish(failure)
      if (code !== 0) return finish(new Error(`爱奇艺国内版本地分片还原失败（${iqcnRestoreReason(diagnostic)}，exit=${code ?? 'signal'}）`))
      try {
        const value = JSON.parse(output) as LocalResult
        if (value.version !== 1 || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > MAX_SEGMENT || (!value.restored && !value.clearCandidate)) throw new Error()
        finish(undefined, value)
      } catch { finish(new Error('本地分片处理返回无效')) }
    })
    if (signal?.aborted) return abort()
    // Material is in process memory and stdin only; never in argv or a file.
    child.stdin.end(JSON.stringify({ ...material, source, destination }))
  })
}

const localRuntime: IQCNLocalRuntime = { fetch: (url, init) => fetch(url, init), restore: restoreIQCNLocal }

export async function downloadIQCNLocalSegment(cli: GwClient, planId: string, index: number, expected: number, material: IQCNProcessing, work: string, signal?: AbortSignal, runtime = localRuntime, initial?: Record<string, unknown>): Promise<Buffer> {
  if (!Number.isSafeInteger(expected) || expected <= 0 || expected > MAX_SEGMENT) throw new Error('爱奇艺国内版分片大小无效或超过 64 MiB')
  const id = randomUUID(), raw = join(work, `iqcn-${id}.source`), clear = join(work, `iqcn-${id}.clear`)
  let firstError = ''
  try {
    let downloaded = false
    for (let refresh = 0; refresh < 2 && !downloaded; refresh++) {
      signal?.throwIfAborted()
      let descriptor: Record<string, unknown>
      try {
        descriptor = refresh === 0 && initial
          ? initial
          : await iqcnSegmentDescriptor(cli, { planId, index, ...(refresh ? { refresh: '1' } : {}) }, signal)
      } catch (error) {
        if (firstError) throw new Error(`${firstError}；刷新分片地址失败`)
        throw error
      }
      signal?.throwIfAborted()
      if (descriptor.transport !== 'local-v1' || descriptor.index !== index || descriptor.bytes !== expected || !Array.isArray(descriptor.urls) || !descriptor.urls.length || descriptor.urls.length > 16) {
        throw new Error('网关分片响应不符合本地下载协议')
      }
      const urls = descriptor.urls.map(mediaURL)
      for (const url of urls) {
        try {
          await fetchSegment(url, raw, expected, runtime.fetch, signal)
          downloaded = true
          break
        } catch (error) {
          signal?.throwIfAborted()
          firstError ||= error instanceof Error ? error.message : '分片直连失败'
        }
      }
    }
    if (!downloaded) throw new Error(firstError || '爱奇艺国内版分片直连失败')
    signal?.throwIfAborted()
    let report: LocalResult
    try { report = await runtime.restore(raw, clear, material, signal) }
    catch (error) {
      signal?.throwIfAborted()
      // Do not echo arbitrary runtime errors (they may contain paths or material).
      const match = /（([a-z_]+)，exit=(\d+|signal)）$/.exec(error instanceof Error ? error.message : '')
      const reason = match && ['material_invalid', 'restore_failed', 'restore_incomplete', 'input_open_failed', 'input_read_failed', 'output_create_failed', 'output_write_failed', 'helper_failed'].includes(match[1]!)
        ? `${match[1]}, exit=${match[2]}` : 'helper_failed'
      throw new Error(`爱奇艺国内版本地分片还原失败（分片 ${index + 1}，${expected} 字节，${reason}）`)
    }
    signal?.throwIfAborted()
    const bytes = readFileSync(clear)
    if ((!report.restored && !report.clearCandidate) || report.version !== 1 || report.bytes !== bytes.length || bytes.length !== expected) throw new Error('爱奇艺国内版本地分片还原或长度校验失败')
    return bytes
  } finally {
    for (const path of [raw, clear]) { try { unlinkSync(path) } catch { /* absent */ } }
  }
}
