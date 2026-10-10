import { expect, test } from 'bun:test'
import { Runtime } from '../runtime.ts'
import { usesMeasuredNaming } from './completed-naming.ts'
import { completedFilename } from './name.ts'
import { jobNaming } from './jobs.ts'
import { iqcnOptions } from './iqcn.ts'

test('terminal batches save one rendition identity and origin with independent task metadata', () => {
  const runtime = new Runtime({ simulate: true }), state = runtime as any
  try {
    state.qualities = iqcnOptions({ formats: [{ id: '800|300|25|ep2DV', codec_code: 1, dynamic_range_code: 1 }] }, 'ep2').qualities
    state.qIdx = 0
    state.audios = []
    state.pending = ['ep2', 'ep3'].map(vid => ({ provider: 'iqcn', vid }))
    state.applyOptions()
    expect(state.pending[1]).toMatchObject({ quality: '800|300|25|ep2DV',
      iqcnQuality: { sourceTvid: 'ep2', codecCode: 1, dynamicRangeCode: 1 } })
    expect(state.pending[0].iqcnQuality).not.toBe(state.pending[1].iqcnQuality)
  } finally { runtime.close() }
})

test('domestic terminal tasks opt into measured naming and preview with IQIYI', () => {
  const runtime = new Runtime({ simulate: true })
  const state = runtime as any
  try {
    state.detailProv = 'iqcn'
    state.detailTitle = '国内节目'
    state.detailInfo = { kind: 'show', year: 2026 }
    state.eps = [{ vid: 'episode', title: '特别篇', season: 0, number: 298, languages: [] }]
    state.cfg.releaseGroup = 'WF'
    state.cfg.includeEpisodeTitle = true
    const task = state.taskFromEp(0)
    expect(task).toMatchObject({ provider: 'iqcn', namingVersion: 1, season: 0, episode: 298 })
    expect(usesMeasuredNaming(JSON.parse(JSON.stringify(task)))).toBe(true)
    state.pending = [{ ...task, height: 2160, codec: 'HEVC' }]
    state.scene = 'confirm'
    state.emit()
    const preview = runtime.snapshot.confirmation
    expect(preview?.name).toBe('国内节目.S00E298.特别篇.2026.2160p.IQIYI.WEB-DL.HEVC-WF.mkv')
    expect(preview?.note).toContain('封装后按实际规格')
    state.cfg.includeEpisodeTitle = false
    const withoutTitle = state.taskFromEp(0)
    expect(completedFilename(jobNaming(withoutTitle, state.cfg), { status: 'unavailable' }))
      .toBe('国内节目.S00E298.2026.IQIYI.WEB-DL-WF.mkv')
  } finally { runtime.close() }
})

test('terminal domestic login opens a QR scene and completes through its polling path', async () => {
  const runtime = new Runtime({ simulate: true })
  const state = runtime as any
  const calls: string[] = []
  state.simulated = false
  state.cfg.host = 'http://127.0.0.1:1'
  state.cfg.key = 'fixture-key'
  state.keyInfo = { scope: ['iqcn'], all: false }
  state.cli = {
    allows: (_scope: string[], _all: boolean, provider: string) => provider === 'iqcn',
    invoke: async (provider: string, action: string, input: Record<string, unknown>) => {
      expect([provider, action]).toEqual(['iqcn', 'login'])
      calls.push(String(input.op))
      return input.op === 'start'
        ? { state: 'pending', flowId: 'terminal-flow', url: 'https://passport.iqiyi.com/fixture', expiresAt: Math.floor(Date.now() / 1000) + 600, interval: 2 }
        : { state: 'authenticated', authenticated: true, summary: '爱奇艺国内版已登录' }
    },
  }
  try {
    expect(state.settingFields()).toContain('爱奇艺国内版扫码')
    await state.openSetting('爱奇艺国内版扫码')
    expect(state.scene).toBe('qr')
    expect(state.qrAscii.length).toBeGreaterThan(0)
    expect(runtime.snapshot.qrHint).toContain('爱奇艺 App')
    await Bun.sleep(2100)
    runtime.tickQR()
    await Bun.sleep(30)
    expect(calls).toEqual(['start', 'poll'])
    expect(state.scene).toBe('settings')
    expect(state.qrIQCN).toBe(false)
  } finally { runtime.close() }
}, 10000)
