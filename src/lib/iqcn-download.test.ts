import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { downloadIQCN } from './iqcn.ts'
import { ensureFFmpeg } from './tools.ts'
import type { GwClient } from './client.ts'
import { JobHub, runTask, type DlTask, type JobEvt } from './jobs.ts'
import type { IQCNLocalRuntime } from './iqcn-local.ts'
import { defaultConfig } from './config.ts'
import { probeFinishedMedia } from './gvs-record.ts'
import { reserveOutputPath } from './completed-naming.ts'
import { actualVersionSummary } from './actual-version.ts'

async function multiAudioFixture(dir: string): Promise<Buffer> {
  const ffmpeg = await ensureFFmpeg(), source = join(dir, 'multi-audio.ts')
  const generated = spawnSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=5.1:sample_rate=48000',
    '-t', '2', '-map', '0:v', '-map', '1:a', '-map', '2:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a:0', 'aac', '-c:a:1', 'eac3', '-f', 'mpegts', source],
    { windowsHide: true, timeout: 30000 })
  expect(generated.status).toBe(0)
  return readFileSync(source)
}

function fixtureClient(bytes: Buffer, subtitles = true, onSegment?: () => void, plan: Record<string, unknown> = {}) {
  let released = 0, active = 0, peak = 0
  const split = Math.floor(bytes.length / 188 / 2) * 188
  const parts = [bytes.subarray(0, split), bytes.subarray(split)]
  const cli = { invoke: async (_p: string, action: string, input: Record<string, unknown>) => {
    if (action === 'probe') return plan
    if (action === 'streams') {
      expect(input.transport).toBe('local-v1')
      return { ...plan, planId: 'fixture-plan', transport: 'local-v1', localProcessing: { version: 1, ticket: 'fixture', identity: 'fixture' },
        video: { ...(plan.video as Record<string, unknown>), segments: parts.map(part => ({ contentlength: part.length })) },
        subtitles: subtitles ? [{ index: 0, language_id: 1, formats: ['srt'] }] : [] }
    }
    if (action === 'download-finish') { released++; return {} }
    if (action === 'download-subtitle') {
      const text = Buffer.from('1\n00:00:00,000 --> 00:00:01,500\n验收字幕\n')
      return { index: 0, language_id: 1, format: 'srt', bytes: text.length, data: text.toString('base64') }
    }
    expect(action).toBe('download-segment')
    onSegment?.()
    const index = Number(input.index)
    return { transport: 'local-v1', index, bytes: parts[index]!.length, urls: [`https://fixture.ptqy.gitv.tv/${index}`] }
  } } as unknown as GwClient
  const runtime: IQCNLocalRuntime = {
    fetch: async url => {
      active++; peak = Math.max(peak, active)
      const index = Number(new URL(url).pathname.slice(1))
      // Keep the first transfer in flight past descriptor pacing, so this
      // verifies local media concurrency despite the shared control queue.
      try { await Bun.sleep(index === 0 ? 450 : 5); return new Response(new Uint8Array(parts[index]!)) }
      finally { active-- }
    },
    restore: async (source, destination) => {
      copyFileSync(source, destination)
      return { version: 1, bytes: readFileSync(source).length, restored: false, clearCandidate: true }
    },
  }
  return { cli, runtime, released: () => released, peak: () => peak }
}

test('domestic shared runner names the measured default audio, preserves S00 and protects collisions and legacy queues', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-iqcn-naming-'))
  let hub: JobHub | undefined
  try {
    const bytes = await multiAudioFixture(dir)
    const cfg = { ...defaultConfig(), outDir: join(dir, 'library'), tmpDir: join(dir, 'work'), releaseGroup: 'WF', threads: 3 }
    const task: DlTask = { provider: 'iqcn', namingVersion: 1, includeEpisodeTitle: true,
      title: '特别篇', series: '国内节目', vid: '123', quality: '600|100|60', height: 2160, codec: 'HEVC',
      season: 0, episode: 298, duration: 2, year: 2026, group: 'WF', tmdbId: 0, nameDots: '', plot: '', kind: 'show' }
    const run = async (id: number, task: DlTask, subtitles = true, plan: Record<string, unknown> = {}) => {
      const fixture = fixtureClient(bytes, subtitles, undefined, plan), events: JobEvt[] = []
      const completed = Promise.withResolvers<JobEvt>()
      hub = new JobHub(e => { events.push(e); if (e.done) completed.resolve(e) },
        (...args) => runTask(...args, fixture.runtime))
      hub.enqueue(cfg, fixture.cli, id, task)
      const timeout = setTimeout(() => completed.reject(new Error('IQCN fixture did not complete')), 30000)
      let final: JobEvt
      try { final = await completed.promise } finally { clearTimeout(timeout); await hub.cancelAll() }
      expect(final.status).toBe('完成')
      expect(final.err).toBe('')
      expect(fixture.released()).toBe(1)
      expect(fixture.peak()).toBe(2)
      expect(events.some(e => e.log.includes('平均') && e.log.includes('MiB/s'))).toBe(true)
      return { final, events }
    }
    // Both audio tracks survive the subtitle mux. AAC is the default even
    // though the later E-AC-3 track has six channels.
    const first = await run(1, task)
    expect(basename(first.final.log)).toBe('国内节目.S00E298.特别篇.2026.360p.IQIYI.WEB-DL.AVC.AAC.2.0-WF.mkv')
    expect(first.final.log).toContain('Season 00')
    expect(first.events.some(e => e.status === '命名')).toBe(true)
    expect(first.final.note).toBe('')
    const specs = await probeFinishedMedia(first.final.log)
    expect(specs).toMatchObject({ status: 'probed', width: 320, height: 240, codec: 'h264', fps: 25,
      audio: { status: 'confirmed', codec: 'aac', channels: 2 } })
    expect(first.final.completedMedia).toEqual({ media: specs, file: { size: readFileSync(first.final.log).length } })
    expect(first.final.actualVersion).toBeUndefined()
    expect(actualVersionSummary(JSON.parse(JSON.stringify(first.final.completedMedia)))).toContain('320×240 · H264 · 25fps')
    const ffmpeg = await ensureFFmpeg()
    const both = spawnSync(ffmpeg, ['-nostdin', '-v', 'error', '-i', first.final.log, '-map', '0:a:0', '-map', '0:a:1', '-f', 'null', '-'],
      { windowsHide: true, timeout: 30000 })
    expect(both.status).toBe(0)
    const original = readFileSync(first.final.log)
    const collision = await run(2, task)
    expect(collision.final.log).not.toBe(first.final.log)
    expect(collision.final.note).toContain('目标文件名已存在')
    expect(readFileSync(first.final.log).equals(original)).toBe(true)
    expect(existsSync(collision.final.log)).toBe(true)
    // The upstream mux maps all embedded audio tracks even without subtitles;
    // measured naming must still follow the first/default AAC track.
    const surround = await run(3, { ...task, episode: 299 }, false)
    expect(basename(surround.final.log)).toBe('国内节目.S00E299.特别篇.2026.360p.IQIYI.WEB-DL.AVC.AAC.2.0-WF.mkv')
    expect((await probeFinishedMedia(surround.final.log)).audio).toMatchObject({ codec: 'aac', channels: 2 })
    const legacy = await run(4, { ...task, namingVersion: undefined, episode: 300 })
    expect(legacy.events.some(e => e.status === '命名')).toBe(false)
    expect(basename(legacy.final.log)).toContain('2160p.IQIYI.WEB-DL')
    expect(basename(legacy.final.log)).not.toContain('AAC.2.0')
    expect(legacy.final.completedMedia?.media).toMatchObject({ status: 'probed', width: 320, height: 240, codec: 'h264' })
    const edrFormat = { id: '800|200|60|edrVideo', vid: 'edrVideo', bid: 800, br: 200, fr: 60, dynamic_range_code: 8 }
    const sdrFormat = { ...edrFormat, id: '800|200|60|sdrVideo', vid: 'sdrVideo', dynamic_range_code: 7 }
    const edrTask = { ...task, episode: 301, quality: edrFormat.id }
    const edr = await run(5, edrTask, true, { video: edrFormat, formats: [edrFormat, sdrFormat] })
    expect(basename(edr.final.log)).toBe('国内节目.S00E301.特别篇.2026.360p.IQIYI.WEB-DL.EDR.AVC.AAC.2.0-WF.mkv')
    expect(JSON.parse(JSON.stringify(edrTask)).namingEvidence).toEqual({ marker: 'EDR', stream: edrFormat.id, evidence: 'download_plan' })
    // A retried task must adopt the latest returned video, even when the
    // requested selector and persisted evidence still describe EDR.
    const retried = { ...edrTask, episode: 302 }
    const fallback = await run(6, retried, true, { video: sdrFormat, formats: [edrFormat, sdrFormat] })
    expect(basename(fallback.final.log)).toBe('国内节目.S00E302.特别篇.2026.360p.IQIYI.WEB-DL.AVC.AAC.2.0-WF.mkv')
    expect(retried.namingEvidence).toEqual({ stream: sdrFormat.id, evidence: 'download_plan' })
  } finally { await hub?.cancelAll(); rmSync(dir, { recursive: true, force: true }) }
}, 120000)

test('domestic mux refuses an output reservation changed during download and still releases its plan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-iqcn-reserved-'))
  try {
    const bytes = await multiAudioFixture(dir), dest = reserveOutputPath(join(dir, 'result.mkv'))
    const fixture = fixtureClient(bytes, false, () => writeFileSync(dest, 'another-output'))
    await expect(downloadIQCN(fixture.cli, { vid: '123', quality: '600|100|25' } as DlTask,
      dest, join(dir, 'work'), () => {}, undefined, fixture.runtime, 1, { reservedOutput: true })).rejects.toThrow('输出占位已改变')
    expect(readFileSync(dest, 'utf8')).toBe('another-output')
    expect(fixture.released()).toBe(1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 60000)

test('domestic job preflights audio and muxes restored media without runtime decode-validation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-iqcn-download-'))
  const ffmpeg = await ensureFFmpeg()
  const source = join(dir, 'source.ts')
  const generated = spawnSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mpegts', source], { windowsHide: true, timeout: 30000 })
  expect(generated.status).toBe(0)
  const audioSources = ['aac', 'eac3'].map((codec, index) => {
    const path = join(dir, `independent-${index}.m4a`)
    const result = spawnSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${600 + index * 500}:sample_rate=48000`, '-t', '2', '-c:a', codec, '-f', 'mp4', path], { windowsHide: true, timeout: 30000 })
    expect(result.status).toBe(0)
    const data = readFileSync(path), split = Math.floor(data.length / 2)
    return [gzipSync(data.subarray(0, split)), data.subarray(split)]
  })
  const audioCatalog = [
    { aid: 'current-aac', name: '普通话', cf: 'aac', ct: 5, bid: 300, language_id: 1, ff: 'amp4', selected: true, has_independent_files: true },
    { aid: 'current-dolby', name: '普通话', cf: 'dolby', ct: 2, bid: 500, language_id: 1, ff: 'amp4' },
    { aid: 'current-standard', name: '普通话', cf: 'aac', ct: 1, bid: 100, language_id: 1, ff: 'amp4' },
    { aid: 'duplicate-dolby', name: '普通话', cf: 'dolby', ct: 2, bid: 500, language_id: 1, ff: 'dash' },
    { aid: 'duplicate-aac', name: '普通话', cf: 'aac', ct: 5, bid: 300, language_id: 1, ff: 'dash' },
    { aid: 'duplicate-standard', name: '普通话', cf: 'aac', ct: 1, bid: 100, language_id: 1, ff: 'dash' },
  ]
  const requestedAudios: string[] = []
  const bytes = readFileSync(source), split = Math.floor(bytes.length / 188 / 2) * 188
  const parts = [bytes.subarray(0, split), bytes.subarray(split)]
  let restored = 0, released = false
  const cli = { invoke: async (_p: string, action: string, input: Record<string, unknown>) => {
    if (action === 'probe') {
      expect(input.tvid).toBe('123')
      return { formats: [
        { id: '600|100|25|currentHDR', codec_code: 1, dynamic_range_code: 2 },
        { id: '600|100|25|currentDV', codec_code: 1, dynamic_range_code: 1 },
      ] }
    }
    if (action === 'streams') {
      expect(input.transport).toBe('local-v1')
      expect(input.vid).toBe('currentDV')
      return { planId: 'fixture-plan', transport: 'local-v1', localProcessing: { version: 1, ticket: 'fixture', identity: 'fixture' }, video: { segments: parts.map(p => ({ contentlength: p.length })) }, audios: audioCatalog, subtitles: [{ index: 0, language_id: 1, formats: ['srt'] }] }
    }
    if (action === 'audio') {
      const selectedIndex = audioCatalog.findIndex(a => a.aid === input.audioId)
      expect([0, 1, 5]).toContain(selectedIndex)
      const track = selectedIndex === 5 ? 2 : selectedIndex
      expect(restored).toBe(0)
      requestedAudios.push(String(input.audioId))
      if (track === 2) return { transport: 'local-audio-v1', audioId: input.audioId, embedded: true, language_id: 1, name: '普通话', codec: 'aac' }
      return { transport: 'local-audio-v1', audioId: input.audioId, language_id: 1, name: '普通话', codec: audioCatalog[selectedIndex]!.cf,
        parts: [0, 1].map(index => ({ index, dispatch: `https://data.video.ptqy.gitv.tv/videos/v0/${track}-${index}.amp4` })) }
    }
    if (action === 'download-finish') { released = true; return {} }
    if (action === 'download-subtitle') {
      const text = Buffer.from('1\n00:00:00,000 --> 00:00:01,500\n验收字幕\n')
      return { index: 0, language_id: 1, format: 'srt', bytes: text.length, data: text.toString('base64') }
    }
    expect(action).toBe('download-segment')
    expect(requestedAudios).toHaveLength(3)
    expect(input.index).toBe(restored++)
    const part = parts[Number(input.index)]!
    return { transport: 'local-v1', index: input.index, bytes: part.length, urls: [`https://fixture.ptqy.gitv.tv/${input.index}`] }
  } } as unknown as GwClient
  const task = { provider: 'iqcn', namingVersion: 1, vid: '123', quality: '600|100|25|previousDV',
    iqcnQuality: { sourceTvid: 'previousEpisode', codecCode: 1, dynamicRangeCode: 1 }, audioTracks: [
    { id: 'iqcn:1:5:300:aac', vid: 'previous-episode-aac', label: '普通话 AAC', isDefault: false },
    { id: 'iqcn:1:2:500:dolby', vid: 'previous-episode-dolby', label: '普通话 DOLBY', isDefault: true },
    { id: 'iqcn:1:1:100:aac', vid: 'previous-episode-standard', label: '普通话 标准', isDefault: false },
    // An old queue could save both UI renditions under the same selector.
    { id: 'iqcn:1:2:500:dolby', vid: 'previous-episode-dolby-dash', label: '普通话 DOLBY', isDefault: false },
  ] } as DlTask
  const dest = join(dir, 'result.mkv')
  const stages: string[] = []
  await downloadIQCN(cli, task, dest, join(dir, 'work'), status => stages.push(status), undefined, {
    fetch: async url => {
      const parsed = new URL(url)
      if (parsed.hostname === 'data.video.ptqy.gitv.tv') return Response.json({ e: '0', l: `https://audio.ptqy.gitv.tv${parsed.pathname}` })
      if (parsed.hostname === 'audio.ptqy.gitv.tv') {
        const [, track, part] = /\/(\d)-(\d).amp4$/.exec(parsed.pathname)!
        if (part === '0') await Bun.sleep(20)
        return new Response(audioSources[Number(track)]![Number(part)]!)
      }
      const index = Number(new URL(url).pathname.slice(1))
      // A later segment finishes first; the assembled video must stay ordered.
      if (index === 0) await Bun.sleep(30)
      return new Response(parts[index]!)
    },
    restore: async (source, destination) => {
      copyFileSync(source, destination)
      return { version: 1, bytes: readFileSync(source).length, restored: false, clearCandidate: true }
    },
  }, 8)
  expect(restored).toBe(2)
  expect(released).toBe(true)
  expect(existsSync(dest)).toBe(true)
  expect(requestedAudios).toEqual(['current-dolby', 'current-aac', 'duplicate-standard'])
  expect(stages).toContain('检查音轨')
  for (const stage of ['抽样检查', '检查视频', '检查成品', '校验视频']) expect(stages).not.toContain(stage)
  const metadata = spawnSync(ffmpeg, ['-hide_banner', '-i', dest], { windowsHide: true, timeout: 30000 }).stderr.toString()
  const audioLines = metadata.split('\n').filter(line => /Stream #.*Audio:/.test(line))
  expect(audioLines).toHaveLength(3)
  expect(audioLines[0]).toContain('eac3')
  expect(audioLines[0]).toContain('(default)')
  expect(audioLines[1]).toContain('aac')
  expect(audioLines[1]).not.toContain('(default)')
  expect(audioLines[2]).toContain('aac')
  expect(audioLines[2]).not.toContain('(default)')
  expect(metadata).not.toContain('普通话 · DOLBY')
  expect(metadata).not.toContain('普通话 · AAC')
  expect(audioLines.every(line => line.includes('(zho)'))).toBe(true)
  expect(task.namingEvidence?.muxAudio).toEqual({ index: 0, count: 3 })
  expect((await probeFinishedMedia(dest, undefined, { muxAudio: task.namingEvidence?.muxAudio })).audio)
    .toMatchObject({ status: 'confirmed', index: 0, codec: 'eac3' })
  expect(task.audioTracks?.map(audio => audio.id)).toEqual([
    'iqcn:1:5:300:aac', 'iqcn:1:2:500:dolby', 'iqcn:1:1:100:aac', 'iqcn:1:2:500:dolby',
  ])
  const subtitleLines = metadata.split('\n').filter(line => /Stream #.*Subtitle:/.test(line))
  expect(subtitleLines).toHaveLength(2)
  expect(subtitleLines[0]).toContain('(default)')
  expect(subtitleLines[1]).not.toContain('(default)')
  expect(metadata).toContain('简体中文')
  expect(metadata).toContain('繁体中文')
  expect(metadata).not.toContain('OpenCC 转换')
  const decoded = spawnSync(ffmpeg, ['-nostdin', '-v', 'error', '-i', dest, '-map', '0:v', '-map', '0:a', '-f', 'null', '-'], { windowsHide: true, timeout: 30000 })
  expect(decoded.status).toBe(0)
  expect(decoded.stderr.toString().trim()).toBe('')
  const subtitle = spawnSync(ffmpeg, ['-nostdin', '-v', 'error', '-i', dest, '-map', '0:s:0', '-f', 'srt', '-'], { windowsHide: true, timeout: 30000 })
  expect(subtitle.status).toBe(0)
  expect(subtitle.stdout.toString()).toContain('验收字幕')
  const traditional = spawnSync(ffmpeg, ['-nostdin', '-v', 'error', '-i', dest, '-map', '0:s:1', '-f', 'srt', '-'], { windowsHide: true, timeout: 30000 })
  expect(traditional.status).toBe(0)
  expect(traditional.stdout.toString()).toContain('驗收字幕')
  const timing = /\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/
  expect(traditional.stdout.toString().match(timing)?.[0]).toBe(subtitle.stdout.toString().match(timing)?.[0])
}, 60000)

test('failed restoration preserves an existing output and releases the private plan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-iqcn-failed-')), dest = join(dir, 'existing.mkv')
  writeFileSync(dest, 'original-output')
  let released = false
  const cli = { invoke: async (_p: string, action: string) => {
    if (action === 'streams') return { planId: 'fixture-plan', transport: 'local-v1', localProcessing: { version: 1, ticket: 'fixture', identity: 'fixture' }, video: { segments: [{ contentlength: 188 }] } }
    if (action === 'download-finish') { released = true; return {} }
    return { transport: 'local-v1', index: 0, bytes: 188, urls: ['https://fixture.ptqy.gitv.tv/0'] }
  } } as unknown as GwClient
  const task = { provider: 'iqcn', namingVersion: 1, namingEvidence: { marker: 'EDR', stream: 'old' }, vid: '123', quality: '600|100|25' } as DlTask
  await expect(downloadIQCN(cli, task, dest, join(dir, 'work'), () => {}, undefined, {
    fetch: async () => new Response(Buffer.alloc(188)),
    restore: async () => { throw new Error('本地还原失败') },
  })).rejects.toThrow('还原')
  expect(task.namingEvidence).toBeUndefined()
  expect(readFileSync(dest, 'utf8')).toBe('original-output')
  expect(released).toBe(true)
  expect(existsSync(dest + '.iqcn-part')).toBe(false)
})

test('missing or unresolved audio fails before fetching video and preserves downloaded work', async () => {
  for (const mode of ['missing', 'unresolved']) {
    const dir = mkdtempSync(join(tmpdir(), 'gvs-iqcn-audio-preflight-')), dest = join(dir, 'result.mkv')
    const video = join(dir, 'iqcn-video.ts')
    writeFileSync(video, 'previously downloaded video')
    const actions: string[] = []
    const cli = { invoke: async (_p: string, action: string) => {
      actions.push(action)
      if (action === 'streams') return { planId: 'fixture-plan', video: { segments: [{ contentlength: 188 }] }, audios: mode === 'missing' ? [] : [{ aid: 'current', language_id: 1, ct: 2, bid: 500, cf: 'dolby', ff: 'dash', name: '普通话' }] }
      if (action === 'download-finish') return {}
      if (action === 'audio') throw new Error('fixture: audio unavailable')
      throw new Error('video should not be requested')
    } } as unknown as GwClient
    const task = { vid: '123', quality: '600|100|25', audioTracks: [{ id: 'iqcn:1:2:500:dolby', label: '普通话 DOLBY' }] } as DlTask
    await expect(downloadIQCN(cli, task, dest, dir, () => {})).rejects.toThrow(mode === 'missing' ? '当前集暂不提供' : '本次尚未下载视频')
    expect(actions).toEqual(mode === 'missing' ? ['streams', 'download-finish'] : ['streams', 'audio', 'download-finish'])
    expect(readFileSync(video, 'utf8')).toBe('previously downloaded video')
    expect(existsSync(dest)).toBe(false)
  }
})
