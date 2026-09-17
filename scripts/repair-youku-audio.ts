// Offline: bun run scripts/repair-youku-audio.ts INPUT.mkv --delay-ms 2000
// Re-fetch: bun run scripts/repair-youku-audio.ts VID INPUT.mkv [AUDIO_STREAM_TYPE] --delay-ms 0
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { GwClient } from '../src/lib/client.ts'
import { loadConfig } from '../src/lib/config.ts'
import { youkuDRM } from '../src/lib/jobs.ts'
import { downloadPlaylist, referer, youkuAudioPlaylist } from '../src/lib/media.ts'
import { retryCdnRefresh } from '../src/lib/cdn-retry.ts'
import { ensureFFmpeg, ensureMkvmerge } from '../src/lib/tools.ts'
import { validateAudio } from '../src/lib/ffmpeg.ts'
import { mkvmergeMux } from '../src/lib/mkvmerge.ts'
import { assertAudioContinuity, assertMediaDuration, inspectMediaTiming } from '../src/lib/media-timing.ts'
import { runTunnel } from '../src/lib/tunnel.ts'

const args = process.argv.slice(2)
for (let i = 0; i < args.length - 1; i++) {
  if (args[i] === '--delay-ms' && args[i + 1]!.startsWith('-') && Number.isFinite(Number(args[i + 1]))) {
    args.splice(i, 2, `--delay-ms=${args[i + 1]}`)
  }
}
const { values, positionals } = parseArgs({ args, allowPositionals: true,
  options: { 'delay-ms': { type: 'string' }, 'track-id': { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } } })
if (values.help) {
  console.log('离线偏移（正数让声音推迟）：INPUT.mkv --delay-ms 毫秒 [--track-id 音轨ID] [--output OUTPUT.mkv]')
  console.log('重新下载音轨：VID INPUT.mkv [AUDIO_STREAM_TYPE] --delay-ms 毫秒 [--output OUTPUT.mkv]')
  console.log('偏移为原始相对起点之外的额外调整；不会用 EXTINF 或裸 tfdt 猜测。离线模式保留其它音轨、字幕和章节。')
  process.exit(0)
}
if (!positionals.length || positionals.length > 3 || values['delay-ms'] === undefined || !values['delay-ms'].trim()) {
  throw new Error('请指定输入文件与 --delay-ms（已确认无需偏移时填 0）；--help 查看用法')
}
const delayMs = Number(values['delay-ms'])
if (!Number.isFinite(delayMs)) throw new Error('--delay-ms 必须是有限毫秒数')
const offline = positionals.length === 1
if (!offline && values['track-id'] !== undefined) throw new Error('--track-id 仅用于离线模式；重新下载时用 AUDIO_STREAM_TYPE 选择音轨')
const vid = offline ? '' : positionals[0]!
const input = resolve(positionals[offline ? 0 : 1]!)
const audioType = positionals[2] ?? ''
const output = resolve(values.output ?? input.replace(/\.mkv$/i, '.sync-fixed.mkv'))
if (!/\.mkv$/i.test(input) || output.toLowerCase() === input.toLowerCase() || existsSync(output)) {
  throw new Error('输入必须是 MKV，修复版必须另存到尚不存在的文件')
}
if (!existsSync(input)) throw new Error('输入文件不存在')
const mkvmerge = await ensureMkvmerge()
const ffmpeg = await ensureFFmpeg()
const run = (args: string[]) => new Promise<string>((resolve, reject) => {
  const p = spawn(mkvmerge, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  p.stdout.on('data', b => { out += b })
  p.stderr.on('data', b => { err += b })
  p.once('error', reject)
  p.once('close', code => code === 0 || code === 1 ? resolve(out) : reject(new Error(`mkvmerge: ${code} ${err || out}`)))
})
const original = JSON.parse(await run(['-J', input]))
const audioTracks = original.tracks.filter((t: any) => t.type === 'audio')
const trackId = values['track-id'] === undefined ? audioTracks[0]?.id : Number(values['track-id'])
if (offline && (!Number.isInteger(trackId) || !audioTracks.some((t: any) => t.id === trackId))) {
  throw new Error('--track-id 必须是输入文件的音轨 ID（mkvmerge -J 可查询）')
}
console.log('检查输入完整性与实际媒体时间戳…')
const before = await inspectMediaTiming(ffmpeg, input)
assertMediaDuration(before, Number(original.container?.properties?.duration) / 1e6)
if (offline) assertAudioContinuity(before)
const work = mkdtempSync(join(dirname(output), '.audio-repair-'))
const partial = join(work, 'verified.mkv')
const abort = new AbortController()
try {
  if (offline) {
    console.log(`无损重封装：音轨 ${trackId} 偏移 ${delayMs}ms`)
    await run(['-o', partial, '--sync', `${trackId}:${Math.round(delayMs)}`, input])
  } else {
    const cfg = loadConfig()
    const cli = new GwClient(cfg.host, cfg.key)
    const request = () => cli.invoke('youku', 'play', { vid, expand: '0', tier: 'multi', nocache: '1' }, cli.extra(cfg, 'youku'))
    async function play() {
      try { return await request() }
      catch (e) {
        if (!(e instanceof Error) || !e.message.includes('隧道未连接')) throw e
        console.log('连接本机出口隧道…')
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('本机隧道连接超时')), 15000)
          runTunnel(cfg.host, cfg.key, (ok, error) => {
            if (ok) { clearTimeout(timer); resolve() }
            else if (error) { clearTimeout(timer); reject(new Error(error)) }
          }, abort.signal)
        })
        return request()
      }
    }
    const audio = join(work, 'audio.mp4')
    await retryCdnRefresh(async () => {
      const data = await play()
      const drm = youkuDRM(data)
      const source = youkuAudioPlaylist(data, audioType)
      if (!source || (drm.audioEnc && !drm.reKey)) throw new Error('没有所选音轨地址或解密密钥')
      await downloadPlaylist({ src: source, dest: audio, ref: referer('youku'), key: drm.audioEnc ? drm.reKey : undefined,
        clear: !drm.audioEnc, select: 'audio', threads: cfg.threads, transport: 'node',
        refreshSource: async () => {
          const fresh = await play(), encryption = youkuDRM(fresh)
          const src = youkuAudioPlaylist(fresh, audioType)
          if (!src) throw new Error('重新取链后缺少所选音轨')
          return { src, key: encryption.audioEnc ? encryption.reKey : undefined }
        },
        onRefresh: (retry, total) => console.log(`音轨重新取 CDN 链接 ${retry}/${total}，继续失败分片`),
      })
    }, (retry, total, delayMs, status) => {
      console.log(`CDN ${status}，${delayMs / 1000} 秒后重新取链（重试 ${retry}/${total}）`)
    })
    await validateAudio(ffmpeg, audio)
    const replacement = await inspectMediaTiming(ffmpeg, audio)
    assertAudioContinuity(replacement)
    const audioEnd = Math.max(...replacement.filter(t => t.type === 'audio').map(t => t.endMs)) + delayMs
    const videoEnd = Math.max(...before.filter(t => t.type === 'video').map(t => t.endMs))
    if (Math.abs(videoEnd - audioEnd) > 2000) throw new Error(`补偿后音视频结束时间不匹配：${videoEnd}ms / ${audioEnd}ms`)
    // Use the original downloaded track; no intermediate MKA can erase timing.
    await mkvmergeMux(mkvmerge, input, [{ path: audio, title: audioType || '优酷音轨', lang: audioTracks[0]?.properties?.language, delayMs }], partial)
  }
  console.log('校验输出完整性与音轨解码…')
  const after = await inspectMediaTiming(ffmpeg, partial)
  assertAudioContinuity(after)
  const videoBefore = before.filter(t => t.type === 'video')
  const videoAfter = after.filter(t => t.type === 'video')
  if (videoBefore.length !== videoAfter.length || videoBefore.some((t, i) =>
    t.packets !== videoAfter[i]!.packets || Math.abs(t.endMs - videoAfter[i]!.endMs) > 2)) {
    throw new Error('输出视频帧数或时间戳改变，未生成修复版')
  }
  if (offline) {
    const audioBefore = before.filter(t => t.type === 'audio')
    const audioAfter = after.filter(t => t.type === 'audio')
    if (audioBefore.length !== audioAfter.length || audioBefore.some((t, i) => {
      const shift = audioTracks[i].id === trackId ? delayMs : 0
      return Math.abs(t.endMs + shift - audioAfter[i]!.endMs) > 2 || (shift >= 0 && t.packets !== audioAfter[i]!.packets)
    })) throw new Error('输出音轨的帧数或偏移与请求不符，未生成修复版')
  }
  await validateAudio(ffmpeg, partial)
  if (existsSync(output)) throw new Error('目标文件已存在，未覆盖')
  renameSync(partial, output)
  if (existsSync(`${partial}.timing.json`)) renameSync(`${partial}.timing.json`, `${output}.timing.json`)
  console.log(`修复完成：${output}`)
} finally {
  abort.abort()
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
