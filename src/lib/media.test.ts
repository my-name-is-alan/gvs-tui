import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanRELog, formatSpeed, hlsExtinfSeconds, hlsKeyArgs, playlistOverall, playlistStatus, reProgress, reHttpFailureMonitor, reSidecarProgress, reWorkPhase, runM3u8dl, CdnDenied, reDownloadedSegments, reListedSegments, streamConcurrencyArgs, transferSpeed } from './media.ts'
import { DownloaderCompatibilityError } from './downloader-error.ts'

test('CENC key is also supplied to the HLS parser, skipping the key URI fetch', () => {
  const key = '0123456789abcdef0123456789abcdef'
  expect(hlsKeyArgs(`${'a'.repeat(32)}:${key}`)).toEqual([
    '--key', `${'a'.repeat(32)}:${key}`, '--custom-hls-key', key, '--custom-hls-method', 'CENC',
  ])
  expect(() => hlsKeyArgs('invalid')).toThrow('密钥格式')
  expect(hlsKeyArgs()).toEqual([])
})

test('a 0-1 HLS ratio is not formatted as bytes per second', () => {
  expect(formatSpeed(0.47, 1, 5)).toBe('速度未知')
  expect(formatSpeed(0.47, 1, 5, { segments: { done: 47, total: 100 } })).toBe('47/100 段 · 速度未知')
  expect(formatSpeed(0.2, 1, 3, { log: '合并 12.0 MB/40.0 MB' })).toBe('合并 12.0 MB/40.0 MB')
  expect(formatSpeed(524288, 1048576, 1)).toBe('512.0 KB/1.0 MB  512.0 KB/s')
})

test('HLS speed uses measured bytes while its percentage remains a phase-weighted ratio', () => {
  expect(formatSpeed(0.42, 1, 100, { segments: { done: 26, total: 85 }, transfer: { bytes: 5242880, bytesPerSecond: 1048576 } }))
    .toBe('26/85 段 · 已下载 5.0 MB · 约 1.0 MB/s')
  expect(formatSpeed(0, 1, 0, { transfer: { bytes: 0 } })).toBe('已下载 0 B · 正在测速')
  expect(formatSpeed(0.5, 1, 10, { transfer: { bytes: 500, bytesPerSecond: 0 } })).toBe('已下载 500 B · 约 0 B/s')
  expect(formatSpeed(0, 1, 0, { phase: 'download' })).toBe('正在测速')
  expect(formatSpeed(1, 1, 10, { phase: 'merge' })).toBe('合并')
})

test('recent byte sampling excludes resumed bytes, detects stalls, and resets on a replaced scratch directory', () => {
  let now = 0
  const measure = transferSpeed(() => now)
  expect(measure(1000000)).toEqual({ bytes: 1000000 })
  now = 500
  expect(measure(1000500).bytesPerSecond).toBe(1000)
  now = 3000
  measure(1000500)
  now = 4000
  expect(measure(1000500).bytesPerSecond).toBe(0)
  now = 4500
  expect(measure(0)).toEqual({ bytes: 0 })
  now = 5000
  expect(measure(500).bytesPerSecond).toBe(1000)
})

test('RE counts bytes in completed and in-flight fragments without counting unfinished segments or merged files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-re-bytes-'))
  const stream = join(dir, 'download', '0____')
  mkdirSync(stream, { recursive: true })
  try {
    writeFileSync(join(dir, 'download', 'meta_selected.json'), '\uFEFF' + JSON.stringify([{ Playlist: {
      MediaParts: [{ MediaSegments: [{}, {}, {}] }], MediaInit: {},
    } }]))
    writeFileSync(join(stream, '_init.mp4'), Buffer.alloc(50))
    writeFileSync(join(stream, '001.ts'), Buffer.alloc(100))
    writeFileSync(join(stream, '002.ts.tmp'), Buffer.alloc(75))
    writeFileSync(join(dir, 'download.mp4'), Buffer.alloc(1000))
    expect(reDownloadedSegments(dir)).toEqual({ done: 2, total: 4, bytes: 225 })
    writeFileSync(join(stream, '002.ts.tmp'), Buffer.alloc(125))
    expect(reDownloadedSegments(dir)).toEqual({ done: 2, total: 4, bytes: 275 })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('in-flight single-file DASH fragments still report bytes (no more 0 B/s)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-re-inflight-'))
  const stream = join(dir, 'download', '0_uuid_avc1.640028_7226948_')
  mkdirSync(stream, { recursive: true })
  try {
    // 元数据被 --write-meta-json false 关掉时，总量退回 RE 控制台的清单数。
    writeFileSync(join(stream, '0.mp4.tmp.downloading'), Buffer.alloc(400))
    writeFileSync(join(stream, '0.mp4.tmp.downloading.meta'), Buffer.alloc(32))
    expect(reDownloadedSegments(dir, 2)).toEqual({ done: 0, total: 2, bytes: 400 })
    writeFileSync(join(stream, '0.mp4.tmp.downloading'), Buffer.alloc(900))
    expect(reDownloadedSegments(dir, 2)).toEqual({ done: 0, total: 2, bytes: 900 })
    // 整段下完：改名成 0.mp4 才算完成
    rmSync(join(stream, '0.mp4.tmp.downloading')); rmSync(join(stream, '0.mp4.tmp.downloading.meta'))
    writeFileSync(join(stream, '0.mp4'), Buffer.alloc(1000))
    expect(reDownloadedSegments(dir, 2)).toEqual({ done: 1, total: 2, bytes: 1000 })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('pipe progress handles partial tokens, multiple redraws and never reports completion early', () => {
  const values: number[] = []
  const feed = reProgress((n) => values.push(n))
  feed('Vid ━━ 1/8 \x1b[32m12.')
  feed('5%\x1b[0m\rVid ━━ 2/10 20%\rVid ━━ 18/100 18%\r')
  feed('Vid ━━ 8/8 100%')
  expect(values).toEqual([0.125, 0.2, 0.99])
})

test('signed URL escapes and unrelated phase percentages never advance download progress', () => {
  const values: number[] = []
  const feed = reProgress((n) => values.push(n))
  feed('INFO: URL https://cdn.test/m3u8?vid=0788%')
  feed('3D%3D&token=12345%257C\nParsing 100%\nDecrypt 100%\n')
  expect(values).toEqual([])
  feed('Vid ━━ 1/325 0.31% 5 MiB/s\n')
  expect(values).toEqual([1 / 325])
})

test('redirection notice is not presented as the error; URLs are redacted', () => {
  expect(cleanRELog('INFO: 输出被重定向\nINFO: Output is redirected.\nERROR: HTTP 403 https://cdn.test/a?token=secret'))
    .toBe('ERROR: HTTP 403 [媒体地址]')
})

test('CDN status detection handles split log lines', () => {
  const monitor = reHttpFailureMonitor()
  const line = 'WARN: Response status code does not indicate success: 403 (Forbidden).\n'
  expect(monitor.feed('INFO: loading https://cdn.test/403/segment\n')).toBe(0)
  expect(monitor.feed(line)).toBe(403)
  expect(monitor.feed('WARN: HTTP 4')).toBe(0)
  expect(monitor.feed('10 Gone\n')).toBe(410)
})

test('a downloader can recover from 403 without being killed', async () => {
  const script = `console.log('WARN: HTTP 403 Forbidden'); setTimeout(() => console.log('INFO: Done'), 350)`
  const result = await runM3u8dl(process.execPath, ['-e', script], '')
  expect(result).toContain('Done')
}, 5000)

test('a failed exit with CDN denial and no final newline triggers URL refresh', async () => {
  await expect(runM3u8dl(process.execPath, ['-e', `process.stdout.write('WARN: HTTP 403 Forbidden'); process.exitCode=1`], '')).rejects.toBeInstanceOf(CdnDenied)
})

test('unsupported IQ format takes precedence over concurrent CDN errors and retains the root exception', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-re-unsupported-'))
  try {
    const log = join(dir, 're.log')
    const fatal = 'Unhandled exception: System.IO.InvalidDataException: Unsupported IQ mdcm encryption pattern key=0123456789abcdef0123456789abcdef https://cdn.test/file?token=secret'
    const script = `require('fs').writeFileSync(process.argv[1], 'Response status code does not indicate success: 502 (Bad Gateway).\\n'); require('fs').writeSync(2, ${JSON.stringify(fatal)} + '\\n' + 'stack frame\\n'.repeat(3000)); process.exitCode = 1`
    const error = await runM3u8dl(process.execPath, ['-e', script, log], log).then(() => undefined, e => e as Error)
    expect(error).toBeInstanceOf(DownloaderCompatibilityError)
    expect(error).not.toBeInstanceOf(CdnDenied)
    expect(error?.message).toContain('Unsupported IQ mdcm encryption pattern')
    expect(error?.message).not.toMatch(/0123456789abcdef|token=secret|https:\/\//)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('unsupported format without an HTTP failure is still a component compatibility error', async () => {
  const script = `console.error('System.IO.InvalidDataException: Unsupported IQ mdcm encryption pattern'); process.exitCode = 1`
  await expect(runM3u8dl(process.execPath, ['-e', script], '')).rejects.toBeInstanceOf(DownloaderCompatibilityError)
})

test('a successful exit is not rejected for recovered CDN warnings in the log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-re-log-'))
  try {
    const log = join(dir, 're.log')
    writeFileSync(log, 'ERROR: Response status code does not indicate success: 410 (Gone).')
    await expect(runM3u8dl(process.execPath, ['-e', `console.log('INFO: Done')`], log)).resolves.toContain('Done')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('stop only once RE explicitly exhausts its own retries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-re-log-'))
  try {
    const log = join(dir, 're.log')
    const script = `require('fs').writeFileSync(process.argv[1], 'WARN: HTTP 403 Forbidden\\nThe retry attempts have been exhausted and the download of this segment has failed.'); setInterval(() => {}, 1000)`
    await expect(runM3u8dl(process.execPath, ['-e', script, log], log)).rejects.toBeInstanceOf(CdnDenied)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 5000)

test('resuming a scratch directory ignores exhausted retries in the previous run log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-re-old-log-')), log = join(dir, 're.log')
  try {
    writeFileSync(log, 'Response status code does not indicate success: 502 (Bad Gateway).\nThe retry attempts have been exhausted\n')
    const script = `setTimeout(() => { require('fs').writeFileSync(process.argv[1], 'fresh run completed'); process.exit(0) }, 700)`
    expect(await runM3u8dl(process.execPath, ['-e', script, log], log, undefined, undefined, dir)).toContain('fresh run completed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 5000)

test('successful exit preserves file diagnostics and redacts keys and media URLs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-re-log-'))
  try {
    const log = join(dir, 're.log'), key = '0123456789abcdef0123456789abcdef'
    const script = `require('fs').writeFileSync(process.argv[1], ${JSON.stringify(`ERROR: decrypt failed; key=${key}; source=https://cdn.test/file?secret=token`)}); console.log('Output is redirected.')`
    const info = await runM3u8dl(process.execPath, ['-e', script, log], log)
    expect(info).toContain('decrypt failed')
    expect(info).not.toContain(key)
    expect(info).not.toContain('secret=token')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('native crash retains the root exception before a long stack and redacts private data', async () => {
  if (process.platform === 'win32') return
  // A shell signal exercises native process failure without Bun's crash-report
  // handler/core dump keeping the CI subprocess alive after SIGABRT.
  const fatal = 'Fatal error.\nSystem.AccessViolationException: invalid memory key=0123456789abcdef0123456789abcdef https://cdn.test/file?token=secret'
  const script = 'ulimit -c 0; printf "%s\\n" "$1" >&2; i=0; while [ "$i" -lt 2000 ]; do printf "stack frame\\n" >&2; i=$((i+1)); done; kill -ABRT "$$"'
  const error = await runM3u8dl('/bin/sh', ['-c', script, 'native-crash-fixture', fatal], '').then(() => undefined, e => e as Error)
  expect(error?.message).toContain('SIGABRT')
  expect(error?.message).toContain('System.AccessViolationException')
  expect(error?.message).not.toMatch(/0123456789abcdef|token=secret|https:\/\//)
})

test('IQ runtime compatibility is passed to the child without reducing concurrency or affecting other methods', async () => {
  const script = `console.log(JSON.stringify({jit:process.env.DOTNET_ReadyToRun ?? null, args:process.argv.slice(1)}))`
  const inherited = process.env.DOTNET_ReadyToRun ?? null
  for (const method of ['IQ_BBTS', 'CENC']) {
    const args = ['-e', script, '--', '--custom-hls-method', method, '--thread-count', '8']
    const result = JSON.parse(await runM3u8dl(process.execPath, args, ''))
    expect(result.jit).toBe(method === 'IQ_BBTS' && process.platform === 'darwin' && process.arch === 'arm64' ? '0' : inherited)
    expect(result.args).toEqual(args.slice(3))
  }
})

test('EXTINF list ignores key and placement tags', () => {
  const infs = hlsExtinfSeconds('#EXTM3U\n#EXTINF:7.983333,\nseg1\n#EXT-X-PLACEMENT-OPPORTUNITY\n#EXTINF:11.333333,\nseg2\n#EXT-X-KEY:METHOD=CENC\n#EXTINF:9.633333,\nseg3\n')
  expect(infs).toEqual([7.983333, 11.333333, 9.633333])
})

test('RE explicit final failure is rejected even when the process exits zero', async () => {
  const script = `console.log('WARN: Download speed too slow!'); console.log('ERROR: Segment count check not pass'); console.log('ERROR: Failed')`
  await expect(runM3u8dl(process.execPath, ['-e', script], '')).rejects.toThrow('Download speed too slow')
})

test('RE log lines switch work from download to merge then decrypt', () => {
  expect(reWorkPhase('Vid ━━ 8/8 100%')).toBe('download')
  expect(reWorkPhase('16:46:15.37 二进制合并中...')).toBe('merge')
  expect(reWorkPhase('Binary merging...\nDecrypting using SHAKA_PACKAGER...')).toBe('decrypt')
})

test('a completed HLS part does not hide the remaining parts download speed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-re-parts-'))
  try {
    const first = join(dir, 'download', '0____', 'parts', '0000'), second = join(dir, 'download', '0____', 'parts', '0001')
    mkdirSync(first, { recursive: true }); mkdirSync(second, { recursive: true })
    writeFileSync(join(dir, 'download', 'meta_selected.json'), JSON.stringify([{ Playlist: { MediaParts: [{ MediaSegments: [{}, {}] }, { MediaSegments: [{}, {}] }] } }]))
    writeFileSync(join(first, '0.ts'), Buffer.alloc(100)); writeFileSync(join(first, '1.ts'), Buffer.alloc(200))
    writeFileSync(join(first, 'part.ts'), Buffer.alloc(300))
    writeFileSync(join(second, '0.ts.tmp'), Buffer.alloc(50))
    expect(reWorkPhase('Binary merging...', dir)).toBe('download')
    expect(reWorkPhase('Binary merging...\nDecrypting using SHAKA_PACKAGER', dir)).toBe('download')
    expect(reDownloadedSegments(dir)).toEqual({ done: 2, total: 4, bytes: 350 })
    rmSync(join(second, '0.ts.tmp'))
    writeFileSync(join(second, '0.ts'), Buffer.alloc(100)); writeFileSync(join(second, '1.ts'), Buffer.alloc(200))
    expect(reWorkPhase('Binary merging...', dir)).toBe('merge')
    writeFileSync(join(dir, 'download.ts'), Buffer.alloc(150))
    const merge = reSidecarProgress(dir, 'merge')
    expect(merge.ratio).toBeCloseTo(0.25)
    expect(merge.log).toBe('合并 150 B/600 B')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('content-key runs without meta_selected.json use the listed segment total before merge', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-re-nometa-'))
  try {
    const part = join(dir, 'download', 'parts', '0000')
    mkdirSync(part, { recursive: true })
    writeFileSync(join(part, '0.m4s'), Buffer.alloc(100)); writeFileSync(join(part, '1.m4s'), Buffer.alloc(100))
    const listing = '00:27:50.1 INFO : 已选择的流:\n00:27:50.1 INFO : Vid *UNKNOWN 3840x1606 | dvh1 | 3 Segments | ~01h00m19s\n' +
      '00:27:50.1 INFO : Sub subtitles | yue-Hant | 廣東話 | 1 Segment | ~01h00m19s\n'
    expect(reListedSegments(listing)).toBeUndefined()
    const total = reListedSegments(listing + '00:27:50.2 INFO : 保存文件名: download\n')
    expect(total).toBe(4)
    expect(reWorkPhase('二进制合并中...', dir, total)).toBe('download')
    writeFileSync(join(part, '2.m4s'), Buffer.alloc(100)); writeFileSync(join(part, '3.vtt'), Buffer.alloc(10))
    writeFileSync(join(part, '3.m4s'), Buffer.alloc(100))
    expect(reWorkPhase('二进制合并中...', dir, total)).toBe('merge')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('running RE keeps reporting bytes while a later HLS part downloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-re-parts-live-'))
  try {
    const part = join(dir, 'download', 'parts', '0000')
    mkdirSync(part, { recursive: true })
    writeFileSync(join(dir, 'download', 'meta_selected.json'), JSON.stringify([{ Playlist: { MediaParts: [{ MediaSegments: [{}, {}, {}, {}] }] } }]))
    writeFileSync(join(part, '0.ts'), Buffer.alloc(100)); writeFileSync(join(part, '1.ts'), Buffer.alloc(200))
    const script = `const fs=require('node:fs');console.log('Binary merging...');setTimeout(()=>{fs.writeFileSync(${JSON.stringify(join(part,'2.ts'))},Buffer.alloc(100));fs.writeFileSync(${JSON.stringify(join(part,'3.ts'))},Buffer.alloc(200));},650);setTimeout(()=>{},1150)`
    const phases: Array<{phase?: string; done?: number; bytes?: number}> = []
    await runM3u8dl(process.execPath, ['-e', script], '', (_n,_total,info) => phases.push({phase:info?.phase,done:info?.segments?.done,bytes:info?.transfer?.bytes}), undefined, dir)
    expect(phases.some(p=>p.phase==='download'&&p.done===2&&p.bytes===300)).toBe(true)
    expect(phases.some(p=>p.phase==='merge')).toBe(true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 5000)

test('sidecar merge and shaka tempfile sizes become visible progress', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-re-bytes-'))
  try {
    mkdirSync(join(dir, 'download'))
    writeFileSync(join(dir, 'download', 'a'), Buffer.alloc(600))
    writeFileSync(join(dir, 'download', 'b'), Buffer.alloc(400))
    writeFileSync(join(dir, 'download.mp4'), Buffer.alloc(250))
    const merge = reSidecarProgress(dir, 'merge')
    expect(merge.ratio).toBeCloseTo(0.25)
    expect(merge.log).toContain('250 B')
    writeFileSync(join(dir, 'download.mp4'), Buffer.alloc(1000))
    expect(reSidecarProgress(dir, 'decrypt').log).toContain('读取')
    writeFileSync(join(dir, 'packager-tempfile-1'), Buffer.alloc(400))
    const first = reSidecarProgress(dir, 'decrypt')
    expect(first.ratio).toBeCloseTo(0.2)
    expect(first.log).toBe('解密 400 B/1000 B')
    writeFileSync(join(dir, 'download_dec.mp4'), Buffer.alloc(500))
    const rewrite = reSidecarProgress(dir, 'decrypt')
    expect(rewrite.ratio).toBeCloseTo(0.75)
    expect(rewrite.log).toContain('回写')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('decrypt overall never jumps backward after download or merge', () => {
  expect(playlistOverall('download', 0.99, true)).toBeLessThan(playlistOverall('merge', 0, true))
  expect(playlistOverall('merge', 1, true)).toBe(playlistOverall('decrypt', 0, true))
  expect(playlistStatus('下载', 'decrypt')).toBe('解密')
  expect(playlistStatus('音轨 中文', 'merge')).toBe('音轨 中文 · 合并')
})

test('runM3u8dl reports shaka tempfile growth while the process is still running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-re-side-'))
  try {
    writeFileSync(join(dir, 'download.mp4'), Buffer.alloc(800))
    const script = `
      const fs = require('fs');
      const path = require('path');
      console.log('Decrypting using SHAKA_PACKAGER...');
      fs.writeFileSync(path.join(process.cwd(), 'packager-tempfile-1'), Buffer.alloc(400));
      setTimeout(() => process.exit(0), 400);
    `
    const seen: { n: number; log?: string; phase?: string }[] = []
    await runM3u8dl(process.execPath, ['-e', script], join(dir, 're.log'), (n, _t, info) => {
      seen.push({ n, log: info?.log, phase: info?.phase })
    }, undefined, dir)
    expect(seen.some(s => s.phase === 'decrypt' && (s.log || '').includes('400 B'))).toBe(true)
    expect(seen.some(s => s.phase === 'decrypt' && s.n > 0)).toBe(true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 5000)


test('Apple nested part merge reports bytes while other selected tracks are pending', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-apple-part-progress-'))
  try {
    const part = join(dir, 'download', '0__dvh1_', 'parts', '0000')
    const fragments = join(part, '0__dvh1_')
    mkdirSync(fragments, { recursive: true })
    writeFileSync(join(fragments, '_init.mp4'), Buffer.alloc(20))
    writeFileSync(join(fragments, '0000.m4s'), Buffer.alloc(480))
    writeFileSync(join(fragments, '0001.m4s'), Buffer.alloc(500))
    writeFileSync(join(part, 'part.mp4'), Buffer.alloc(500))
    expect(reWorkPhase('Binary merging...', dir, 100)).toBe('merge')
    const merging = reSidecarProgress(dir, 'merge')
    expect(merging.ratio).toBeCloseTo(0.5)
    expect(merging.log).toContain('500 B/1000 B')
    writeFileSync(join(part, 'part.mp4'), Buffer.alloc(1000))
    writeFileSync(join(part, 'a'.repeat(32) + '.mp4'), Buffer.alloc(400))
    expect(reWorkPhase('Binary merging...\nDecrypting using SHAKA_PACKAGER...', dir, 100)).toBe('decrypt')
    const decrypting = reSidecarProgress(dir, 'decrypt')
    expect(decrypting.ratio).toBeCloseTo(0.4)
    expect(decrypting.log).toContain('400 B/1000 B')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('RE reports nested decrypt growth even when its console output ends at merge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-apple-part-live-'))
  try {
    const part = join(dir, 'download', '0__dvh1_', 'parts', '0000')
    const fragments = join(part, '0__dvh1_')
    mkdirSync(fragments, { recursive: true })
    writeFileSync(join(fragments, '0000.m4s'), Buffer.alloc(1000))
    const script = `const fs=require('node:fs');const path=require('node:path');
      console.log('Selected streams:');console.log('Vid | 100 Segments');console.log('Save Name: download');
      fs.writeFileSync(${JSON.stringify(join(part, 'part.mp4'))},Buffer.alloc(1000));
      console.log('Binary merging...');
      setTimeout(()=>fs.writeFileSync(${JSON.stringify(join(part, 'b'.repeat(32) + '.mp4'))},Buffer.alloc(500)),300);
      setTimeout(()=>{
        fs.unlinkSync(${JSON.stringify(join(part, 'b'.repeat(32) + '.mp4'))});
        const next=${JSON.stringify(join(dir,'download','audio','parts','0000','track'))};
        fs.mkdirSync(next,{recursive:true});fs.writeFileSync(path.join(next,'0000.m4s.tmp'),Buffer.alloc(200));
      },650);
      setTimeout(()=>{},1100);`
    const seen: { n: number; phase?: string; log?: string }[] = []
    await runM3u8dl(process.execPath, ['-e', script], '', (n,_total,info) => seen.push({n,phase:info?.phase,log:info?.log}), undefined, dir)
    const decryptIndex=seen.findIndex(s=>s.phase==='decrypt' && s.n>0 && s.log?.includes('500 B/1000 B'))
    expect(decryptIndex).toBeGreaterThanOrEqual(0)
    expect(seen.slice(decryptIndex+1).some(s=>s.phase==='download')).toBe(true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
},5000)

test('concurrent streams flag is only added when asked for', () => {
  // N_m3u8DL-RE processes one selected stream at a time unless -mt is given;
  // DRM OTT downloads (video + audio) opt in, everything else stays sequential.
  expect(streamConcurrencyArgs(true)).toEqual(['-mt'])
  expect(streamConcurrencyArgs(false)).toEqual([])
})
