import { expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tencentActualVersion } from './actual-version.ts'
import { fileFingerprint, finishedMediaRecord, finishedVersionRecord, mediaSpecsFromProbe, probeFinishedMedia, saveVersionRecord } from './gvs-record.ts'
import { readMp4Tracks } from './mp4box.ts'

test('fingerprint survives rename, detects content changes and agrees with the Python reader', () => {
  const root = mkdtempSync(join(tmpdir(), 'gvs-record-'))
  try {
    const file = join(root, 'before.mkv'), renamed = join(root, 'after.mkv')
    writeFileSync(file, Buffer.alloc(300000, 42))
    const before = fileFingerprint(file)
    // Portable TS tests do not require the sibling project; local bridge verification opts in.
    if (process.env.GVS_VERIFY_BEFLOW) {
      const beflow = process.env.GVS_BEFLOW_DIR
      if (!beflow) throw new Error('Set GVS_BEFLOW_DIR to the directory containing rename_core.py')
      const script = `import sys\nsys.path.insert(0, sys.argv[1])\nfrom rename_core import _gvs_file_identity\nprint(_gvs_file_identity(sys.argv[2])[1])`
      expect(execFileSync('python3', ['-c', script, beflow, file], { encoding: 'utf8' }).trim()).toBe(before.fingerprint.value)
    }
    renameSync(file, renamed)
    expect(fileFingerprint(renamed)).toEqual(before)
    writeFileSync(renamed, Buffer.alloc(300000, 43))
    expect(fileFingerprint(renamed).fingerprint.value).not.toBe(before.fingerprint.value)
    writeFileSync(renamed, '')
    expect(fileFingerprint(renamed).size).toBe(0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('probe specs use video bitrate or video BPS tag, never total container bitrate', () => {
  const payload = { streams: [{ codec_type: 'video', codec_name: 'hevc', width: 3840, height: 1636,
    avg_frame_rate: '24000/1001', tags: { BPS: '7881000', DURATION: '01:28:00.000' }, color_transfer: 'smpte2084' }], format: { bit_rate: '10000000', duration: '5280' } }
  expect(mediaSpecsFromProbe(JSON.stringify(payload))).toMatchObject({ status: 'probed', width: 3840, height: 1636,
    videoBitrate: 7881000, durationSeconds: 5280, dynamicRange: 'HDR' })
  delete (payload.streams[0] as { tags?: unknown }).tags
  expect(mediaSpecsFromProbe(JSON.stringify(payload)).videoBitrate).toBeUndefined()
  expect(mediaSpecsFromProbe('{bad')).toEqual({ status: 'unavailable' })
  expect(mediaSpecsFromProbe('{"streams":[]}')).toEqual({ status: 'unavailable' })
})

test('container duration cannot substitute for missing video duration', () => {
  const result = mediaSpecsFromProbe(JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'hevc' }], format: { duration: '2765' } }))
  expect(result.durationSeconds).toBeUndefined()
})

test('central archive retains multiple completions without writing alongside the video', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gvs-central-'))
  try {
    const file = join(root, 'tiny.mkv')
    writeFileSync(file, 'not-media')
    const actual = tencentActualVersion({ video: { url: 'https://cdn.example/v', format_id: '322093' } },
      'https://cdn.example/v', 'default', { formatId: '322157' }, 'vid')
    const record = await finishedVersionRecord(file, actual)
    expect(record.media.status).toBe('unavailable')
    expect(record.file.size).toBe(9)
    const archive = join(root, 'profile', 'actual-versions.jsonl')
    saveVersionRecord(file, record, archive)
    saveVersionRecord(file, record, archive)
    const saved = readFileSync(archive, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    expect(saved).toHaveLength(2)
    expect(saved[0]).toEqual({ schemaVersion: 1, output: file, actualVersion: record })
    expect(saved[1]).toEqual(saved[0])
    expect(readdirSync(root).sort()).toEqual(['profile', 'tiny.mkv'])
    expect(JSON.stringify(record)).not.toContain('cdn.example')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('missing ffprobe is nonfatal and no download is attempted', async () => {
  const previous = process.env.PATH
  try {
    process.env.PATH = ''
    expect(await probeFinishedMedia('/nonexistent/video.mkv')).toEqual({ status: 'unavailable' })
  } finally { process.env.PATH = previous }
})

test('completed media reuses naming specs and records size even if a legacy probe fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-completed-media-'))
  try {
    const path = join(dir, 'video.mkv')
    writeFileSync(path, Buffer.alloc(4096))
    const media = { status: 'probed' as const, width: 1920, height: 1080, codec: 'h264', fps: 25 }
    let calls = 0
    const probe = async () => { calls++; throw new Error('ffprobe unavailable') }
    expect(await finishedMediaRecord(path, undefined, media, probe)).toEqual({ media, file: { size: 4096 } })
    expect(calls).toBe(0)
    expect(await finishedMediaRecord(path, undefined, undefined, probe))
      .toEqual({ media: { status: 'unavailable' }, file: { size: 4096 } })
    expect(calls).toBe(1)
    const controller = new AbortController()
    controller.abort(new Error('paused'))
    await expect(finishedMediaRecord(path, controller.signal, media, probe)).rejects.toThrow('paused')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('default audio selection follows container/mux evidence instead of highest codec', () => {
  const video = { codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160 }
  const aac = { codec_type: 'audio', id: '0x2', codec_name: 'aac', channels: 2, disposition: { default: 1 } }
  const dts = { codec_type: 'audio', id: '0x3', codec_name: 'dts', channels: 6, disposition: { default: 0 } }
  const payload = (a: unknown, b: unknown) => JSON.stringify({ streams: [video, a, b] })
  expect(mediaSpecsFromProbe(payload(aac, dts)).audio).toMatchObject({ status: 'confirmed', codec: 'aac', channels: 2, evidence: 'container' })
  expect(mediaSpecsFromProbe(payload({ ...aac, disposition: { default: 0 } }, { ...dts, disposition: { default: 1 } })).audio)
    .toMatchObject({ status: 'confirmed', codec: 'dts', channels: 6 })
  expect(mediaSpecsFromProbe(payload(aac, dts), { enabledAudioTrackIds: [3] }).audio)
    .toMatchObject({ codec: 'dts', channels: 6, evidence: 'mp4_enabled' })
  const noDefaults = payload({ ...aac, disposition: {} }, dts)
  expect(mediaSpecsFromProbe(noDefaults).audio?.status).toBe('ambiguous')
  expect(mediaSpecsFromProbe(noDefaults, { muxAudio: { index: 1, count: 2 } }).audio)
    .toMatchObject({ codec: 'dts', evidence: 'mux_order' })
  expect(mediaSpecsFromProbe(noDefaults, { muxAudio: { index: 1, count: 3 } }).audio?.status).toBe('ambiguous')
  expect(mediaSpecsFromProbe(noDefaults, { muxAudio: { index: 1, count: 2 }, enabledAudioTrackIds: [] }).audio?.status).toBe('ambiguous')
  expect(mediaSpecsFromProbe(payload(aac, { ...dts, disposition: { default: 1 } })).audio?.status).toBe('ambiguous')
})

test('cover art is ignored and unreadable/absent audio never fabricates AAC or stereo', () => {
  const video = { codec_type: 'video', codec_name: 'hevc', width: 3840, height: 1600 }
  const cover = { codec_type: 'video', codec_name: 'mjpeg', width: 200, height: 200, disposition: { attached_pic: 1 } }
  const result = mediaSpecsFromProbe(JSON.stringify({ streams: [cover, video,
    { codec_type: 'audio', disposition: { default: 1 } }] }))
  expect(result.width).toBe(3840)
  expect(result.codec).toBe('hevc')
  expect(result.audio).toMatchObject({ status: 'confirmed' })
  expect(result.audio?.codec).toBeUndefined()
  expect(result.audio?.channels).toBeUndefined()
  expect(mediaSpecsFromProbe(JSON.stringify({ streams: [video] })).audio?.status).toBe('none')
})

const realMediaTest = ['ffmpeg', 'ffprobe', 'MP4Box'].every(bin => spawnSync(bin, ['-version'],
  { stdio: 'ignore', timeout: 8000 }).status === 0) ? test : test.skip

realMediaTest('real MKV/MP4 defaults change measured audio from AAC to DDP and MP4 enable flags win', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gvs-default-audio-'))
  const ff = (args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 })
  try {
    const mkv = join(root, 'default-aac.mkv'), other = join(root, 'default-ddp.mkv'), mp4 = join(root, 'default-ddp.mp4')
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=25', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=5.1:sample_rate=48000', '-map', '0:v', '-map', '1:a', '-map', '2:a',
      '-t', '0.3', '-c:v', 'mpeg4', '-c:a:0', 'aac', '-c:a:1', 'eac3', '-disposition:a:0', 'default', '-disposition:a:1', '0', mkv])
    expect((await probeFinishedMedia(mkv)).audio).toMatchObject({ codec: 'aac', channels: 2, evidence: 'container' })
    ff(['-i', mkv, '-map', '0', '-c', 'copy', '-disposition:a:0', '0', '-disposition:a:1', 'default', other])
    expect((await probeFinishedMedia(other)).audio).toMatchObject({ codec: 'eac3', channels: 6 })
    ff(['-i', other, '-map', '0', '-c', 'copy', mp4])
    const before = (await readMp4Tracks('MP4Box', mp4)).filter(t => t.type === 'soun')
    expect(before).toHaveLength(2)
    execFileSync('MP4Box', ['-enable', String(before[0]!.id), '-disable', String(before[1]!.id), mp4], { stdio: 'ignore', timeout: 30000 })
    const probed = await probeFinishedMedia(mp4, undefined, { muxAudio: { index: 1, count: 2 } })
    expect(probed.audio).toMatchObject({ codec: 'aac', channels: 2, evidence: 'mp4_enabled' })
    execFileSync('MP4Box', ['-disable', String(before[0]!.id), '-enable', String(before[1]!.id), mp4], { stdio: 'ignore', timeout: 30000 })
    expect((await probeFinishedMedia(mp4)).audio).toMatchObject({ codec: 'eac3', channels: 6, evidence: 'mp4_enabled' })
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 60000)

realMediaTest('real DTS 5.1 default is read instead of the retained AAC track', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gvs-default-dts-'))
  try {
    const file = join(root, 'default-dts.mkv')
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=25',
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=5.1:sample_rate=48000', '-map', '0:v', '-map', '1:a', '-map', '2:a',
      '-t', '0.3', '-c:v', 'mpeg4', '-c:a:0', 'aac', '-c:a:1', 'dca', '-strict', '-2',
      '-disposition:a:0', '0', '-disposition:a:1', 'default', file], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 })
    expect((await probeFinishedMedia(file)).audio).toMatchObject({ codec: 'dts', channels: 6, index: 1, evidence: 'container' })
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 60000)
