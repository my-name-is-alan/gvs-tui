import { expect, test } from 'bun:test'
import { actualVersionDetail, actualVersionSummary, actualVersionText, tencentActualVersion } from './actual-version.ts'
import { pickTencentDownload, pickTencentDownloadURL } from './media.ts'

const url = 'https://cdn.example/video.m3u8?token=SECRET'
const selected = { stream: 'suhd', caption: 'hard', formatId: '322157', persona: '2741517771455_硬' }
const row = { id: '322157', name: 'suhd', caption: '硬', persona: selected.persona, width: 3840, height: 1636, fs: 1128670539 }

test('unknown rendition identity still displays verified 1080p file specs instead of the selected 4K catalog', () => {
  const record = tencentActualVersion({ video: { url }, formats: [row] }, url, 'default', selected, 'vid')
  record.media = { status: 'probed', width: 1920, height: 1080, codec: 'hevc', fps: 25, videoBitrate: 458784 }
  record.file = { size: 157286400, fingerprint: { algorithm: 'sha256-samples-v1', value: 'test' } }
  expect(actualVersionSummary(record)).toBe('1920×1080 · HEVC · 25fps · 视频 0.46 Mbps · 150.0 MB')
  expect(actualVersionSummary(record)).not.toContain('3840')
  expect(actualVersionDetail(record)).toContain('封装完成后的文件大小')
  expect(actualVersionDetail(record)).not.toContain('格式')
  expect(record.status).toBe('unknown')
  expect(record.actual).toBeNull()
})

test('download summary omits rendition identity and keeps file size when media probing is unavailable', () => {
  const record = tencentActualVersion({ video: { url, format_id: '322093', defn: 'suhd' } }, url, 'default', selected, 'vid')
  record.media = { status: 'probed', width: 3840, height: 2160, codec: 'hevc', fps: 23.9936, dynamicRange: 'SDR' }
  record.file = { size: 1610612736, fingerprint: { algorithm: 'sha256-samples-v1', value: 'test' } }
  expect(actualVersionSummary(record)).toBe('3840×2160 · HEVC · 23.99fps · SDR · 1.5 GB')
  expect(actualVersionSummary({ ...record, actual: null, status: 'unknown', media: { status: 'unavailable' } }))
    .toBe('1.5 GB')
  expect(actualVersionSummary({ ...record, file: undefined, media: { status: 'unavailable' } })).toBe('')
  expect(actualVersionSummary({ ...record, file: undefined })).toBe('3840×2160 · HEVC · 23.99fps · SDR')
})

test('selected row with its own URL records actual identity and keeps compatible URL selection', () => {
  const data = { video: { url: 'https://cdn.example/default.m3u8' }, formats: [{ ...row, url }] }
  const picked = pickTencentDownload(data, selected, 'vid1')
  expect(picked.url).toBe(pickTencentDownloadURL(data, selected))
  expect(picked.version.status).toBe('confirmed')
  expect(picked.version.actual).toMatchObject({ stream: 'suhd', formatId: '322157', caption: 'hard', persona: selected.persona, estimatedBytes: 1128670539 })
  expect(picked.version.matchesSelection).toBe('same')
  expect(picked.version.evidence).toBe('format_url')
  expect(picked.version.addressSource).toBe('format')
  expect(JSON.stringify(picked.version)).not.toContain('SECRET')
})

test('catalog presence does not establish the default URL identity', () => {
  const picked = pickTencentDownload({ video: { url }, formats: [row, { id: '322093', name: 'suhd' }] }, selected)
  expect(picked.url).toBe(url)
  expect(picked.version.status).toBe('unknown')
  expect(picked.version.actual).toBeNull()
  expect(picked.version.matchesSelection).toBe('unknown')
  expect(picked.version.addressSource).toBe('default')
})

test('explicit default video format ID records the different version without blocking download', () => {
  const picked = pickTencentDownload({ video: { url, format_id: '322093', defn: 'suhd' }, formats: [row] }, selected)
  expect(picked.url).toBe(url)
  expect(picked.version.actual?.formatId).toBe('322093')
  expect(picked.version.matchesSelection).toBe('different')
  expect(picked.version.evidence).toBe('video_metadata')
  expect(actualVersionText(picked.version)).toContain('与所选版本不同')
})

test('generic video id and a single catalog row are not proof of format identity', () => {
  const result = tencentActualVersion({ video: { url, id: 'video-id', defn: 'suhd' }, formats: [row] }, url, 'default', selected, 'vid')
  expect(result.status).toBe('unknown')
  expect(result.actual).toBeNull()
})

test('multiple conflicting formats sharing one URL remain ambiguous', () => {
  const result = tencentActualVersion({ formats: [{ ...row, url }, { ...row, id: '322093', url }] }, url, 'format', selected, 'vid')
  expect(result.status).toBe('unknown')
  expect(result.evidence).toBe('ambiguous')
})

test('a URL row conflicting with explicit video metadata cannot confirm actual identity', () => {
  const result = tencentActualVersion({ formats: [{ ...row, url }], video: { url, format_id: '322093' } }, url, 'format', selected, 'vid')
  expect(result.status).toBe('unknown')
  expect(result.actual).toBeNull()
  expect(result.evidence).toBe('ambiguous')
})

test('a chosen CDN mirror is confirmed only when that mirror has bound format metadata', () => {
  const mirror = 'https://mirror.example/actual.m3u8'
  const data = { video: { url, urls: [url, mirror], format_id: '322093', defn: 'suhd' } }
  const result = tencentActualVersion(data, mirror, 'default', selected, 'vid')
  expect(result.actual?.formatId).toBe('322093')
  expect(result.evidence).toBe('video_metadata')
  expect(tencentActualVersion(data, 'https://other.example/v.m3u8', 'default', selected, 'vid').status).toBe('unknown')
})

test('duplicate identical format rows are accepted', () => {
  expect(tencentActualVersion({ formats: [{ ...row, url }, { ...row, url }] }, url, 'format', selected, 'vid').status).toBe('confirmed')
})

test('URL-bound stream metadata without format ID remains partially identified', () => {
  const result = tencentActualVersion({ formats: [{ name: 'maxplus', url }] }, url, 'format', { stream: 'maxplus' }, 'vid')
  expect(result.actual?.stream).toBe('maxplus')
  expect(result.status).toBe('unknown')
  expect(actualVersionText(result)).toBe('实际版本未确认')
})

test('exact filename component can identify a format but substring matches cannot', () => {
  const data = { formats: [{ ...row, fname: 'v.p322157.mp4' }] }
  const matched = tencentActualVersion(data, 'https://cdn.example/v.p322157.mp4?vkey=SECRET', 'default', selected, 'vid')
  expect(matched.evidence).toBe('format_filename')
  expect(matched.actual?.formatId).toBe('322157')
  expect(tencentActualVersion(data, 'https://cdn.example/prefix-v.p322157.mp4-extra', 'default', selected, 'vid').status).toBe('unknown')
})

test('a same format ID without persona cannot verify the requested encoding persona', () => {
  const result = tencentActualVersion({ video: { url, format_id: '322157', defn: 'suhd', caption: 'hard' } }, url, 'default', selected, 'vid')
  expect(result.status).toBe('confirmed')
  expect(result.matchesSelection).toBe('unknown')
})

test('signed URLs, credentials, payload extras and malicious identifiers are omitted', () => {
  const result = tencentActualVersion({ formats: [{ ...row, url, cookie: 'COOKIE', content_key_hex: 'KEY',
    profile: 'https://private.example/token' }], drm: { key: 'KEY' } }, url, 'format', { ...selected, stream: url }, 'vid')
  const serialized = JSON.stringify(result)
  for (const secret of ['SECRET', 'COOKIE', 'KEY', 'private.example', 'https://']) expect(serialized).not.toContain(secret)
  expect(result.selected.stream).toBeUndefined()
})

test('final refreshed URL supplies refreshed identity instead of the first response', () => {
  const first = pickTencentDownload({ formats: [{ ...row, url }] }, selected, 'vid', 0)
  const final = pickTencentDownload({ video: { url, format_id: '322093', defn: 'suhd' } }, selected, 'vid', 1)
  expect(first.version.actual?.formatId).toBe('322157')
  expect(final.version.actual?.formatId).toBe('322093')
  expect(final.version.refreshes).toBe(1)
})

test('missing URLs and malformed format entries stay unknown', () => {
  const picked = pickTencentDownload({ formats: [null, {}, 'bad'] }, selected)
  expect(picked.url).toBe('')
  expect(picked.version.status).toBe('unknown')
})
