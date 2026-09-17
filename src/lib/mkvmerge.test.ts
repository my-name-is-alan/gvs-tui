import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkvmergeMuxArgs } from './mkvmerge.ts'

const dir = mkdtempSync(join(tmpdir(), 'gvs-sync-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function box(type: string, body: Buffer): Buffer {
  const buf = Buffer.alloc(8 + body.length)
  buf.writeUInt32BE(buf.length, 0)
  buf.write(type, 4, 4, 'ascii')
  body.copy(buf, 8)
  return buf
}

function mdhd(timescale: number): Buffer {
  const body = Buffer.alloc(24)
  body.writeUInt32BE(timescale, 12)
  return box('mdhd', body)
}

function tfdt(base: number): Buffer {
  const body = Buffer.alloc(8)
  body.writeUInt32BE(base, 4)
  return box('tfdt', body)
}

function fmp4(timescale: number, base: number): Buffer {
  return Buffer.concat([
    box('ftyp', Buffer.from('isom')),
    box('moov', box('trak', box('mdia', mdhd(timescale)))),
    box('moof', box('traf', tfdt(base))),
  ])
}

test('a fragment decode time cannot establish an audio presentation delay', () => {
  const video = join(dir, 'video.mp4')
  const audio = join(dir, 'audio.mp4')
  writeFileSync(video, fmp4(60, 0))
  writeFileSync(audio, fmp4(60, 479))
  const args = mkvmergeMuxArgs(join(dir, 'out.mkv'), video, [{ path: audio, title: 'AAC', lang: 'chi' }])
  expect(args).toContain('--compression')
  expect(args).not.toContain('--sync')
  expect(mkvmergeMuxArgs('out.mkv', video, [{ path: audio, delayMs: 0 }])).not.toContain('--sync')
})

test('explicit measured delays are scoped to the correct audio input', () => {
  const args = mkvmergeMuxArgs('out.mkv', 'missing-v.mp4', [{ path: 'missing-a.mp4', delayMs: 7983 }])
  expect(args[args.indexOf('--sync') + 1]).toBe('0:7983')
  expect(mkvmergeMuxArgs('out.mkv', 'missing-v.mp4', [{ path: 'missing-a.mp4' }]).includes('--sync')).toBe(false)
  const multi = mkvmergeMuxArgs('out.mkv', 'v.mp4', [{ path: 'a1.mp4', delayMs: 2000 }, { path: 'a2.mp4', delayMs: -300 }])
  expect(multi.slice(multi.indexOf('a1.mp4') - 2, multi.indexOf('a1.mp4') + 1)).toEqual(['--sync', '0:2000', 'a1.mp4'])
  expect(multi.slice(-3)).toEqual(['--sync', '0:-300', 'a2.mp4'])
})

test('invalid explicit delays fail before spawning the muxer', () => {
  for (const delayMs of [NaN, Infinity, -Infinity]) {
    expect(() => mkvmergeMuxArgs('out.mkv', 'v.mp4', [{ path: 'a.mp4', delayMs }])).toThrow('有限毫秒数')
  }
})
