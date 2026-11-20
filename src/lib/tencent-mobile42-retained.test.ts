import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decodeTencentMobile42Segment, downloadTencentMobile42 } from './tencent-mobile42.ts'

/** Explicit local retained replay only. These expired captures do not establish current authorization or whole-film playback. */
test.skipIf(!process.env.GVS_MOBILE42_RETAINED_GATEWAY)('retained EP36 first/NONE/main use real shared Go decoder and ordered consumer with zero upstream requests', async () => {
  const gateway = process.env.GVS_MOBILE42_RETAINED_GATEWAY!
  const capture = join(gateway, 'tmp/tencent-ep36-gateway-live-20261111/live-complete')
  const response = join(capture, 'play-response-private.json')
  const envelope = JSON.parse(readFileSync(response, 'utf8')) as { code: number; data: Record<string, unknown> }
  expect(envelope.code).toBe(0)
  const vid = String(envelope.data.vid)
  const cases = [
    { index: 0, file: join(capture, 'first-segment-private.bin'), bytes: 5831384, sha: '684b682a8bdbcf7b607444bd96e554305d1333cc86121bf0ac73846ce4601882' },
    { index: 10, file: join(gateway, 'tmp/tencent-mobile42-mixed-20261111/none-segment-private.bin'), bytes: 1877932, sha: '2dfa2519f0ef4fcd5c1040c9a7de0f60c8b40bc3f8d76d4cd009cdd8a71c25d5' },
    { index: 62, file: join(capture, 'main-segment-private.bin'), bytes: 5699972, sha: '0883fb1a7e794068043d7e07ee65b3ea4b4a787af71f831ef8799dd82d37fb34' },
  ]
  const dir = mkdtempSync(join(tmpdir(), 'mobile42-retained-'))
  try {
    for (const sample of cases) {
      const out = join(dir, `original-${sample.index}.ts`)
      await decodeTencentMobile42Segment(response, sample.file, out, vid, sample.index)
      const clear = readFileSync(out)
      expect(clear.length).toBe(sample.bytes)
      expect(createHash('sha256').update(clear).digest('hex')).toBe(sample.sha)
    }
    // Derived three-entry playlist solely to test bounded scheduling; it is not a continuous/full playback manifest.
    let activeKey = '', extinf = '', index = 0
    const selected = new Map<number, { key: string; extinf: string; url: string }>()
    for (const raw of String(envelope.data.manifest).split(/\r?\n/)) {
      const line = raw.trim()
      if (line.startsWith('#EXT-X-KEY:')) activeKey = line
      else if (line.startsWith('#EXTINF:')) extinf = line
      else if (line && !line.startsWith('#')) {
        if (cases.some(sample => sample.index === index)) selected.set(index, { key: activeKey, extinf, url: line })
        index++
      }
    }
    expect(selected.size).toBe(3)
    const manifest = '#EXTM3U\n' + cases.map(sample => {
      const entry = selected.get(sample.index)!
      return `${entry.key}\n${entry.extinf}\n${entry.url}\n`
    }).join('') + '#EXT-X-ENDLIST\n'
    const derived = { ...envelope.data, manifest }
    let requests = 0, observed = 0
    const output = join(dir, 'ordered-retained.ts')
    await downloadTencentMobile42(derived, vid, output, dir, 3, bytes => { observed = bytes }, undefined, {
      fetch: async input => {
        const sample = cases.find(sample => selected.get(sample.index)!.url === String(input))
        if (!sample) throw new Error('unexpected retained resource')
        requests++
        const raw = readFileSync(sample.file)
        return new Response(raw, { headers: { 'Content-Length': String(raw.length) } })
      },
    })
    expect(requests).toBe(3)
    expect(observed).toBe(cases.reduce((sum, sample) => sum + readFileSync(sample.file).length, 0))
    const ordered = readFileSync(output)
    let offset = 0
    for (const sample of cases) {
      expect(createHash('sha256').update(ordered.subarray(offset, offset + sample.bytes)).digest('hex')).toBe(sample.sha)
      offset += sample.bytes
    }
    expect(ordered.length).toBe(offset)
    expect(readdirSync(dir).some(name => name.startsWith('tx-mobile42-'))).toBe(false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 120_000)
