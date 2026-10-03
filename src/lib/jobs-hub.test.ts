import { expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobHub, discardJobWork, jobWorkDir, nextJobID, patchJob, seedJobID, tmpRoot, type DlTask, type JobEvt } from './jobs.ts'
import type { FileConfig } from './config.ts'
import type { GwClient } from './client.ts'
import * as media from './media.ts'

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

function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `gvs-${tag}-`))
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const never = () => new Promise<void>(() => {})

/** A runner that blocks until released, recording what it was given. */
function blockingRunner() {
  const state = {
    started: [] as string[],
    finished: [] as string[],
    aborted: [] as string[],
    release: {} as Record<string, () => void>,
    hooks: [] as Array<{ vid: string; downloaded: () => void }>,
  }
  const run = async (
    _emit: (e: JobEvt) => void, _cfg: FileConfig, _cli: GwClient, _id: number, t: DlTask,
    signal?: AbortSignal, hooks?: { downloaded?: () => void },
  ) => {
    state.started.push(t.vid)
    if (hooks) state.hooks.push({ vid: t.vid, downloaded: () => hooks.downloaded?.() })
    signal?.addEventListener('abort', () => state.aborted.push(t.vid), { once: true })
    await new Promise<void>((resolve) => { state.release[t.vid] = resolve })
    state.finished.push(t.vid)
  }
  return { state, run }
}

test('seedJobID never lowers the counter and nextJobID keeps climbing', () => {
  const before = nextJobID()
  seedJobID(0)
  seedJobID(before - 5)
  expect(nextJobID()).toBe(before + 1)
  seedJobID(before + 100)
  expect(nextJobID()).toBe(before + 101)
  seedJobID(Number.NaN)
  seedJobID(Number.POSITIVE_INFINITY)
  expect(nextJobID()).toBe(before + 102)
})

test('enqueue ignores an id that is already queued or running', async () => {
  const { state, run } = blockingRunner()
  const hub = new JobHub(() => {}, run)
  const cfg = {} as FileConfig
  const cli = {} as GwClient
  hub.enqueue(cfg, cli, 7, task({ provider: 'hongguo', vid: 'a' }))
  hub.enqueue(cfg, cli, 7, task({ provider: 'hongguo', vid: 'a-dup' }))
  hub.enqueue(cfg, cli, 8, task({ provider: 'hongguo', vid: 'b' }))
  await until(() => state.started.length === 2)
  expect(state.started).toEqual(['a', 'b'])
  // A third enqueue of a running id must not spawn another runner either.
  hub.enqueue(cfg, cli, 7, task({ provider: 'hongguo', vid: 'a-again' }))
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(state.started).toEqual(['a', 'b'])
  expect(hub.isActive(7)).toBe(true)
  expect(hub.isActive(99)).toBe(false)
  state.release.a!()
  state.release.b!()
  await hub.cancelAll()
})

test('cancel drops a queued job without emitting anything or running it', async () => {
  const events: JobEvt[] = []
  let ran = false
  // Both slots are held by a runner that never settles, so job 3 stays queued.
  const hub = new JobHub(() => {}, async () => { ran = true; await never() })
  const cfg = {} as FileConfig
  const cli = {} as GwClient
  hub.enqueue(cfg, cli, 1, task({ provider: 'hongguo', vid: 'x' }))
  hub.enqueue(cfg, cli, 2, task({ provider: 'hongguo', vid: 'y' }))
  hub.enqueue(cfg, cli, 3, task({ vid: 'queued' }))
  expect(await hub.cancel(3)).toBe('queued')
  expect(events).toEqual([])
  expect(ran).toBe(true) // only the two slot holders
  expect(hub.isActive(3)).toBe(false)
  expect(await hub.cancel(3)).toBe('none')
  expect(await hub.cancel(404)).toBe('none')
})

test('cancel on a running job aborts it and only resolves once the runner settled', async () => {
  const { state, run } = blockingRunner()
  const hub = new JobHub(() => {}, run)
  const cfg = {} as FileConfig
  const cli = {} as GwClient
  hub.enqueue(cfg, cli, 11, task({ provider: 'hongguo', vid: 'a' }))
  await until(() => state.started.length === 1)

  let settled = false
  const cancelled = hub.cancel(11, 'pause').then((r) => { settled = true; return r })
  await until(() => state.aborted.length === 1)
  // The runner promise has not settled, so cancel must still be pending: a
  // resume must not be able to start while the old processes still hold files.
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(settled).toBe(false)

  state.release.a!()
  expect(await cancelled).toBe('running')
  expect(state.finished).toEqual(['a'])
})

test('cancelAll aborts every running job and waits for all of them', async () => {
  const { state, run } = blockingRunner()
  const hub = new JobHub(() => {}, run)
  const cfg = {} as FileConfig
  const cli = {} as GwClient
  hub.enqueue(cfg, cli, 1, task({ provider: 'hongguo', vid: 'h1' }))
  hub.enqueue(cfg, cli, 2, task({ provider: 'hongguo', vid: 'h2' }))
  await until(() => state.started.length === 2)

  let all = false
  const done = hub.cancelAll('cancel').then(() => { all = true })
  await until(() => state.aborted.length === 2)
  expect(all).toBe(false)
  state.release.h1!()
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(all).toBe(false)
  state.release.h2!()
  await done
  expect(state.finished.sort()).toEqual(['h1', 'h2'])
})

test('hooks.downloaded frees the youku slot exactly once so a second youku job starts', async () => {
  const { state, run } = blockingRunner()
  const hub = new JobHub(() => {}, run)
  const cfg = {} as FileConfig
  const cli = {} as GwClient
  hub.enqueue(cfg, cli, 1, task({ vid: 'en' }))
  hub.enqueue(cfg, cli, 2, task({ vid: 'zh' }))
  hub.enqueue(cfg, cli, 3, task({ vid: 'yue' }))
  await until(() => state.started.includes('en'))
  expect(state.started).toEqual(['en'])

  const en = state.hooks.find((h) => h.vid === 'en')!
  en.downloaded()
  // The slot frees when the download phase finishes, not when the job ends.
  await until(() => state.started.includes('zh'))
  // The job still counts toward the overall two-job limit until it settles.
  state.release.en!()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(state.started).toEqual(['en', 'zh'])

  // A second call after the job settled must not free a slot again: with a
  // double decrement the third youku job would start while `zh` still muxes.
  en.downloaded()
  hub.enqueue(cfg, cli, 4, task({ vid: 'yue2' }))
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(state.started).toEqual(['en', 'zh'])

  state.release.zh!()
  await until(() => state.started.includes('yue'))
  state.release.yue!()
  state.release.yue2!
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(state.started).toEqual(['en', 'zh', 'yue', 'yue2'])
})

test('tmpRoot follows tmpDir and defaults beside the library', () => {
  expect(tmpRoot({ outDir: 'D:\\GVS', tmpDir: '' } as FileConfig)).toBe(join('D:\\GVS', '.gvs-tmp'))
  expect(tmpRoot({ outDir: 'D:\\GVS', tmpDir: 'E:\\cache' } as FileConfig)).toBe('E:\\cache')
})

test('jobWorkDir is deterministic, per-task and under tmpRoot', () => {
  const cfg = { outDir: 'D:\\GVS', tmpDir: '' } as FileConfig
  const a = task({ vid: 'XEN', audioTracks: [{ id: 'x|atmos', label: '杜比', lang: '普通话' }] })
  const b = task({ vid: 'XEN', audioTracks: [{ id: 'x|atmos', label: '杜比', lang: '普通话' }] })
  expect(jobWorkDir(cfg, a)).toBe(jobWorkDir(cfg, b))
  expect(jobWorkDir(cfg, a).startsWith(tmpRoot(cfg))).toBe(true)
  expect(jobWorkDir(cfg, a)).toContain('job-youku-XEN-')

  const variants = [
    a,
    task({ vid: 'XEN', quality: '1080p' }),
    task({ vid: 'XEN', height: 1080 }),
    task({ vid: 'XEN', audioTracks: [{ id: 'x|aac', label: 'AAC', lang: '英语' }] }),
    task({ vid: 'XEN', episode: 2 }),
    task({ vid: 'YEN' }),
    task({ vid: 'XEN', edition: '国语版' }),
    task({ vid: 'XEN', provider: 'hongguo' }),
  ].map((t) => jobWorkDir(cfg, t))
  expect(new Set(variants).size).toBe(variants.length)
  // A vid with characters Windows rejects must still produce a usable folder.
  const sanitized = jobWorkDir(cfg, task({ vid: 'a:b/c*?' }))
  expect(sanitized).toContain('job-youku-a_')
  expect(/[:*?/\\]/.test(sanitized.slice(sanitized.lastIndexOf('job-')))).toBe(false)
})

test('Tencent resume chunks are isolated by rendition and subtitle choice', () => {
  const cfg = { outDir: '/tmp/library', tmpDir: '' } as FileConfig
  const base = task({ provider: 'tencent', vid: 'same', quality: 'suhd', caption: 'hard', tencentQuality: { formatId: '322157', persona: '2741517771455_硬', group: 'encode' } })
  const paths = [base, { ...base, tencentQuality: { ...base.tencentQuality, formatId: '322093' } },
    { ...base, tencentQuality: { ...base.tencentQuality, persona: 'default_硬' } },
    { ...base, caption: 'soft' }, { ...base, tencentQuality: undefined }].map(t => jobWorkDir(cfg, t))
  expect(new Set(paths).size).toBe(paths.length)
  expect(jobWorkDir(cfg, JSON.parse(JSON.stringify(base)))).toBe(paths[0]!)
})

test('Tencent runner keeps compatible play parameters and downloads a returned default stream', async () => {
  const outDir = tempDir('gvs-tencent-selection')
  const calls: Array<Record<string, unknown>> = []
  const cli = {
    invoke: async (_provider: string, _action: string, input: Record<string, unknown>) => {
      calls.push(input)
      return { em: 0, has_url: true, defn: 'suhd', width: 3840, height: 1636,
        video: { url: 'https://cdn.invalid/default.mp4' },
        formats: [{ id: '322093', name: 'suhd', caption: '硬', width: 3840, height: 1636 }] }
    },
    extra: () => ({}),
    observeTencentTransfer: () => {},
  } as unknown as GwClient
  const urls: string[] = []
  const download = spyOn(media, 'downloadProgress').mockImplementation(async (src, _dest, _ref, cb) => {
    urls.push(src)
    cb?.(0.42, 1, { phase: 'download', segments: { done: 26, total: 85 }, transfer: { bytes: 5242880, bytesPerSecond: 1048576 } })
    throw new Error('fixture: download reached')
  })
  try {
    const t = task({ provider: 'tencent', vid: 'test', quality: 'suhd', caption: 'hard', tencentQuality: { formatId: '322157', persona: '2741517771455_硬', group: 'encode' } })
    const cfg = { outDir, tmpDir: '', releaseGroup: 'WF', threads: 4, tencentMode: 'tv' } as FileConfig
    const events: JobEvt[] = []
    const hub = new JobHub(e => events.push(e))
    hub.enqueue(cfg, cli, 25, t)
    await until(() => events.some(e => e.done))
    expect(calls).toEqual([{ vid: 'test', defn: 'suhd', caption: 'hard', session_type: 'tv' }])
    const final = events.find(e => e.done)!
    expect(final.status).toBe('失败')
    expect(final.err).toBe('fixture: download reached')
    expect(events.some(e => e.status === '下载')).toBe(true)
    expect(events.some(e => e.status === '下载' && e.log === '26/85 段 · 已下载 5.0 MB · 约 1.0 MB/s')).toBe(true)
    expect(urls).toEqual(['https://cdn.invalid/default.mp4'])
  } finally { download.mockRestore(); rmSync(outDir, { recursive: true, force: true }) }
})

test('discardJobWork removes the job folder and an emptied tmpRoot', async () => {
  const outDir = tempDir('gvs-work')
  try {
    const cfg = { outDir, tmpDir: '' } as FileConfig
    const t = task({ vid: 'XEN' })
    const work = jobWorkDir(cfg, t)
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, '.XEN.enc.mp4'), 'partial')
    await discardJobWork(cfg, t)
    expect(existsSync(work)).toBe(false)
    expect(existsSync(tmpRoot(cfg))).toBe(false)
    // Discarding an already-gone folder is not an error.
    await discardJobWork(cfg, t)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

/** A client whose gateway call hangs until it is rejected after the abort. */
function pendingGateway() {
  const state = { calls: 0, reject: (_e: Error) => {} }
  const cli = {
    invoke: () => {
      state.calls++
      return new Promise<Record<string, unknown>>((_resolve, reject) => { state.reject = reject })
    },
  } as unknown as GwClient
  return { state, cli }
}

test('runTask reports a pause as one stopped event and keeps the work dir', async () => {
  const outDir = tempDir('gvs-pause')
  try {
    const t = task({ provider: 'douyin', vid: '123', url: 'https://www.douyin.com/video/123' })
    const cfg = { outDir, tmpDir: '', releaseGroup: 'ADWeb', threads: 4 } as FileConfig
    const work = jobWorkDir(cfg, t)
    const { state, cli } = pendingGateway()
    const events: JobEvt[] = []
    const hub = new JobHub((e) => events.push(e))
    hub.enqueue(cfg, cli, 21, t)
    await until(() => state.calls === 1)

    // cancel() aborts synchronously, then waits for the runner to settle — so
    // a slow gateway call with no signal of its own delays the resolution.
    const cancelled = hub.cancel(21, 'pause')
    state.reject(new Error('gateway down'))
    expect(await cancelled).toBe('running')

    const final = events.filter((e) => e.done)
    expect(final).toHaveLength(1)
    expect(final[0]!.stopped).toBe('pause')
    expect(final[0]!.status).toBe('已暂停')
    expect(final[0]!.err).toBe('')
    expect(events.some((e) => e.status === '失败')).toBe(false)
    // A pause keeps the partial download so the resume can reuse it.
    expect(existsSync(work)).toBe(true)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('runTask reports a cancel as one stopped event and deletes the work dir', async () => {
  const outDir = tempDir('gvs-cancel')
  try {
    const t = task({ provider: 'douyin', vid: '456', url: 'https://www.douyin.com/video/456' })
    const cfg = { outDir, tmpDir: '', releaseGroup: 'ADWeb', threads: 4 } as FileConfig
    const work = jobWorkDir(cfg, t)
    const { state, cli } = pendingGateway()
    const events: JobEvt[] = []
    const hub = new JobHub((e) => events.push(e))
    hub.enqueue(cfg, cli, 22, t)
    await until(() => state.calls === 1)

    const cancelled = hub.cancel(22)
    state.reject(new Error('gateway down'))
    expect(await cancelled).toBe('running')

    const final = events.filter((e) => e.done)
    expect(final).toHaveLength(1)
    expect(final[0]!.stopped).toBe('cancel')
    expect(final[0]!.status).toBe('已取消')
    expect(events.some((e) => e.status === '失败')).toBe(false)
    expect(existsSync(work)).toBe(false)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('a stopped job still clears a stale note without touching pct', () => {
  const jobs = [{ id: 1, title: 't', status: '下载', pct: 0.4, log: 'x', err: '', note: 'old' }]
  patchJob(jobs, { id: 1, status: '已暂停', pct: 0.4, log: '', err: '', done: true, stopped: 'pause' })
  expect(jobs[0]!.status).toBe('已暂停')
  expect(jobs[0]!.note).toBe('')
  expect(jobs[0]!.pct).toBe(0.4)
})
