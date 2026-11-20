import { afterEach, expect, test } from 'bun:test'
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { bindMobile42PlayInput, decodeTencentMobile42Segment, downloadTencentMobile42, MOBILE42_PROFILE, mobile42DownloadPlan, privateMobile42Scratch } from './tencent-mobile42.ts'

const vid = 'l4102y2spzy'
const key = '#EXT-X-KEY:METHOD=0E9CA2BAE3E3CCC9,URI="data:text/plain;base64,dHhkaWQ9QTU4NEMyQ0I0NTY1M0I4NQ==",KEYFORMAT="com.tencent.qqlive"'
const dirs: string[] = []
const work = () => { const dir = mkdtempSync(join(tmpdir(), 'tx-mobile42-test-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

export function fixturePlay() {
  return { protocol: 'mobile42', vid, manifest: `#EXTM3U\n${key}\n#EXTINF:1,\nhttps://fixture.invalid/0.ts?secret=PRIVATE\n#EXT-X-KEY:METHOD=NONE\n#EXT-X-DISCONTINUITY\n#EXTINF:1,\nhttps://fixture.invalid/1.ts\n${key}\n#EXTINF:1,\nhttps://fixture.invalid/2.ts\n#EXT-X-ENDLIST\n`,
    media: [{ type: 'video', url: 'https://fixture.invalid/list.m3u8', drm: { supported: true, client_profile: MOBILE42_PROFILE,
      crypto_context: { version: 1, profile: MOBILE42_PROFILE, transport: 'chacha20_v3', codec: 'sdd_v2_hevc', transport_offset_origin: 'hls_segment',
        transport_key_b64: Buffer.alloc(32).toString('base64'), transport_nonce_b64: Buffer.alloc(12).toString('base64'),
        codec_key_b64: Buffer.alloc(32).toString('base64'), codec_nonce_b64: Buffer.alloc(12).toString('base64') } } }] }
}

test('mobile42 binds only explicit app episode/definition without mutating the profile or inventing scene data', () => {
  const mobile = { Account: { UserID: 'fixture' }, Device: { GUID: 'fixture' }, Scene: { VID: vid, Defn: 'fhd', Atime: 0 }, Signing: { DD: 'PRIVATE_DD' } }
  const input = { protocol: 'mobile42', session_type: 'app', account_source: 'app_sync', mobile: JSON.stringify(mobile), vid, defn: 'suhd' }
  const bound = bindMobile42PlayInput(input)
  expect(JSON.parse(String(bound.mobile))).toEqual({ ...mobile, Scene: { ...mobile.Scene, Defn: 'suhd' } })
  expect(input.mobile).toBe(JSON.stringify(mobile))
  for (const bad of [ { ...input, session_type: 'tv' }, { ...input, account_source: 'inline' },
    { ...input, mobile: JSON.stringify({ ...mobile, Account: { Cookie: 'SECRET' } }) },
    { ...input, vid: 'otherVid123', mobile: JSON.stringify({ ...mobile, Scene: { VID: vid, PreVID: 'asset' } }) } ]) {
    expect(() => bindMobile42PlayInput(bad)).toThrow('配置无效')
  }
})

test('mobile42 plan accepts matching repeated key and NONE, rejects profiles, ranges, rotations and unbounded playlists before fetch', () => {
  const data = fixturePlay()
  expect(mobile42DownloadPlan(data, vid)).toMatchObject({ duration: 3 })
  expect(mobile42DownloadPlan(data, vid).urls).toHaveLength(3)
  for (const manifest of [data.manifest.replace(key, '#EXT-X-KEY:METHOD=AES-128,URI="https://fixture.invalid/key"'),
    data.manifest.replace('#EXTINF:1,', '#EXT-X-BYTERANGE:188@0\n#EXTINF:1,'),
    data.manifest.replace('#EXT-X-ENDLIST', ''), data.manifest.replace('https://fixture.invalid/0.ts?secret=PRIVATE', 'file:///tmp/source'),
    data.manifest.replace(`${key}\n#EXTINF:1,\nhttps://fixture.invalid/2.ts`, `${key.replace('QTU4', 'QjU4')}\n#EXTINF:1,\nhttps://fixture.invalid/2.ts`)]) {
    expect(() => mobile42DownloadPlan({ ...data, manifest }, vid)).toThrow('声明不受支持')
  }
  expect(() => mobile42DownloadPlan(data, 'wrongvid000')).toThrow()
  expect(() => mobile42DownloadPlan({ ...data, media: [{ ...data.media[0], drm: { ...data.media[0]!.drm, client_profile: 'new' } }] }, vid)).toThrow()
})

test('mobile42 downloads complete bounded segments, keeps response private, processes each manifest index and writes in order', async () => {
  const dir = work(), output = join(dir, 'result.ts'), seen: number[] = [], progress: number[] = []
  const data = fixturePlay()
  await downloadTencentMobile42(data, vid, output, dir, 3, bytes => progress.push(bytes), undefined, {
    fetch: async (input, init) => {
      expect(init?.redirect).toBe('manual')
      expect(init?.headers).toEqual({ 'User-Agent': 'qqlive', Accept: '*/*' })
      expect(init?.headers).not.toHaveProperty('Range')
      const index = Number(new URL(String(input)).pathname[1])
      if (index === 0) await Bun.sleep(25)
      return new Response(Buffer.from([index + 1]), { headers: { 'Content-Length': '1' } })
    },
    decode: async (response, source, destination, expected, index) => {
      expect(expected).toBe(vid)
      if (process.platform !== 'win32') expect(lstatSync(response).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(response, 'utf8'))).toEqual({ code: 0, data })
      seen.push(index)
      copyFileSync(source, destination)
    },
  })
  expect(readFileSync(output)).toEqual(Buffer.from([1, 2, 3]))
  expect(seen.sort()).toEqual([0, 1, 2])
  expect(progress).toEqual([1, 2, 3])
  expect(readdirSync(dir)).toEqual(['result.ts'])
})

test('mobile42 rejection/cancel removes response, raw segments and incomplete result, and never overwrites output', async () => {
  for (const scenario of ['oversized', 'partial', 'truncated', 'decode', 'cancel'] as const) {
    const dir = work(), output = join(dir, 'result.ts'), ctrl = new AbortController()
    let decoded = 0
    const result = downloadTencentMobile42(fixturePlay(), vid, output, dir, 1, () => {}, ctrl.signal, {
      fetch: async () => {
        if (scenario === 'cancel') ctrl.abort(new Error('fixture cancel'))
        return new Response(Buffer.from([1]), { status: scenario === 'partial' ? 206 : 200,
          headers: { 'Content-Length': scenario === 'oversized' ? String(33 << 20) : scenario === 'truncated' ? '2' : '1' } })
      },
      decode: async () => { decoded++; throw new Error('fixture decode failure') },
    })
    await expect(result).rejects.toThrow()
    expect(readdirSync(dir)).toEqual([])
    if (scenario !== 'decode') expect(decoded).toBe(0)
  }
  const dir = work(), output = join(dir, 'existing.ts')
  writeFileSync(output, 'existing')
  let fetched = false
  await expect(downloadTencentMobile42(fixturePlay(), vid, output, dir, 1, () => {}, undefined,
    { fetch: async () => { fetched = true; throw new Error() }, decode: async () => {} })).rejects.toThrow()
  expect(fetched).toBe(false)
  expect(readFileSync(output, 'utf8')).toBe('existing')
  expect(readdirSync(dir)).toEqual(['existing.ts'])
})

test('invalid mobile42 context or unknown public selector rejects before any CDN request', async () => {
  const data = fixturePlay(), original = data.media[0]!.drm.crypto_context
  const bad = [ { ...data, manifest: data.manifest.replaceAll('dHhkaWQ9QTU4NEMyQ0I0NTY1M0I4NQ==', 'dHhkaWQ9QjU4NEMyQ0I0NTY1M0I4NQ==') },
    ...(['transport_key_b64', 'transport_nonce_b64', 'codec_key_b64', 'codec_nonce_b64'] as const).flatMap(field =>
      ['?', Buffer.alloc(1).toString('base64'), original[field] + '\n'].map(value => ({ ...data, media: [{ ...data.media[0], drm: { ...data.media[0]!.drm, crypto_context: { ...original, [field]: value } } }] }))) ]
  const dir = work()
  let requests = 0
  for (const invalid of bad) await expect(downloadTencentMobile42(invalid, vid, join(dir, 'result'), dir, 1, () => {}, undefined,
    { fetch: async () => { requests++; throw new Error() }, decode: async () => {} })).rejects.toThrow('声明不受支持')
  expect(requests).toBe(0)
  expect(readdirSync(dir)).toEqual([])
})

test('Windows private scratch grants only current SID before response creation; malformed SID/ACL failures clean up', () => {
  const dir = work(), calls: Array<{ command: string; args: string[] }> = []
  const scratch = privateMobile42Scratch(dir, 'win32', (command, args) => {
    calls.push({ command, args })
    if (command === 'whoami.exe') return { status: 0, stdout: '"fixture\\user","S-1-5-21-123-456-789-1000"\r\n' }
    expect(readdirSync(args[0]!)).toEqual([])
    return { status: 0, stdout: '' }
  })
  expect(calls).toEqual([
    { command: 'whoami.exe', args: ['/user', '/fo', 'csv', '/nh'] },
    { command: 'icacls.exe', args: [scratch, '/inheritance:r', '/grant:r', '*S-1-5-21-123-456-789-1000:(OI)(CI)F', '/Q'] },
  ])
  rmSync(scratch, { recursive: true, force: true })
  for (const bad of ['malformed', '"user","S-1-5-21bad"', '"user","S-1-5-21"\nEXTRA']) {
    expect(() => privateMobile42Scratch(dir, 'win32', () => ({ status: 0, stdout: bad }))).toThrow('私有工作目录')
    expect(readdirSync(dir)).toEqual([])
  }
  expect(() => privateMobile42Scratch(dir, 'win32', command => command === 'whoami.exe'
    ? { status: 0, stdout: '"user","S-1-5-21"' } : { status: 1, stdout: 'PRIVATE_PATH_ERROR' })).toThrow('私有工作目录')
  expect(readdirSync(dir)).toEqual([])
})

test.skipIf(process.platform === 'win32')('mobile42 helper passes no keys in argv and validates output receipt; diagnostics stay private', async () => {
  const dir = work(), binary = join(dir, 'fake-helper'), response = join(dir, 'private-response.json'), source = join(dir, 'source'), output = join(dir, 'output')
  writeFileSync(response, JSON.stringify({ data: { private: 'PRIVATE_KEY' } }), { mode: 0o600 })
  writeFileSync(source, 'bytes')
  const script = `#!/usr/bin/env node\nconst fs=require('fs'),c=require('crypto');const args=process.argv.slice(2);if(args.join(' ').includes('PRIVATE_KEY'))process.exit(4);const get=k=>args[args.indexOf(k)+1];if(get('--segment-index')!=='2')process.exit(5);const b=fs.readFileSync(get('--segment'));fs.writeFileSync(get('--output'),b,{flag:'wx',mode:0o600});process.stdout.write('decoded_bytes='+b.length+' sha256='+c.createHash('sha256').update(b).digest('hex')+' network_requests=0 native_runtime=false\\n');`
  writeFileSync(binary, script, { mode: 0o700 })
  writeFileSync(`${binary}.sha256`, createHash('sha256').update(script).digest('hex'))
  const previous = process.env.GVS_TENCENT_MOBILE42_DECODE
  process.env.GVS_TENCENT_MOBILE42_DECODE = binary
  try {
    await decodeTencentMobile42Segment(response, source, output, vid, 2)
    expect(readFileSync(output, 'utf8')).toBe('bytes')
    await expect(decodeTencentMobile42Segment(response, source, output, vid, 2)).rejects.toThrow('本地分片处理失败')
    const overflow = '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(10000));setInterval(()=>{},1000)\n'
    writeFileSync(binary, overflow)
    writeFileSync(`${binary}.sha256`, createHash('sha256').update(overflow).digest('hex'))
    await expect(decodeTencentMobile42Segment(response, source, join(dir, 'overflow'), vid, 2)).rejects.toThrow('本地处理返回异常')
    writeFileSync(binary, script + '\n//changed')
    expect(() => decodeTencentMobile42Segment(response, source, join(dir, 'new'), vid, 2)).toThrow('校验失败')
    expect(existsSync(join(dir, 'new'))).toBe(false)
  } finally { if (previous === undefined) delete process.env.GVS_TENCENT_MOBILE42_DECODE; else process.env.GVS_TENCENT_MOBILE42_DECODE = previous }
})
