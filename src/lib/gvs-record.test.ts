import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tencentActualVersion } from './actual-version.ts'
import { fileFingerprint, finishedVersionRecord, mediaSpecsFromProbe, probeFinishedMedia, saveVersionRecord } from './gvs-record.ts'

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
    avg_frame_rate: '24000/1001', tags: { BPS: '7881000' }, color_transfer: 'smpte2084' }], format: { bit_rate: '10000000', duration: '5280' } }
  expect(mediaSpecsFromProbe(JSON.stringify(payload))).toMatchObject({ status: 'probed', width: 3840, height: 1636,
    videoBitrate: 7881000, durationSeconds: 5280, dynamicRange: 'HDR' })
  delete (payload.streams[0] as { tags?: unknown }).tags
  expect(mediaSpecsFromProbe(JSON.stringify(payload)).videoBitrate).toBeUndefined()
  expect(mediaSpecsFromProbe('{bad')).toEqual({ status: 'unavailable' })
  expect(mediaSpecsFromProbe('{"streams":[]}')).toEqual({ status: 'unavailable' })
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
