import { afterEach, expect, spyOn, test } from 'bun:test'
import { GwClient, ReloginRequired } from './client'
import { userMessage } from './user-message'
import { tencentRisk } from './tencent-risk'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLogEnabled, setRunLogDisabled } from './runlog'

let mock: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined
afterEach(() => { mock?.mockRestore() })

test('localized relogin still triggers the dedicated exception with an independent code', async () => {
  mock = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ code: 401, msg: '平台登录状态已失效，请重新登录。', error_code: 'RELOGIN_REQUIRED' }, { status: 401 }))
  const client = new GwClient('https://gateway.example', 'key')
  try { await client.invoke('youku', 'play', {}); throw new Error('expected failure') }
  catch (error) {
    expect(error).toBeInstanceOf(ReloginRequired)
    expect(userMessage(error)).toContain('重新登录')
    expect(userMessage(error)).not.toContain('RELOGIN')
  }
})

test('localized risk rejection stops the flow regardless of its HTTP status', () => {
  const error = Object.assign(new Error('本次操作未完成'), { errorCode: 'RISK_REJECTED', httpStatus: 503 })
  expect(tencentRisk(undefined, error).stop).toBe(true)
  expect(tencentRisk(undefined, Object.assign(new Error('重新登录'), { errorCode: 'ACCOUNT_BINDING_INVALID' })).decision).toBe('reauth_required')
})

test('localized audio failures retain gateway status and error code in the run log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvs-invoke-error-'))
  const previousPath = process.env.GVS_TUI_LOG_PATH, previousLog = process.env.GVS_TUI_LOG
  const logging = runLogEnabled()
  try {
    process.env.GVS_TUI_LOG_PATH = join(dir, 'run.log')
    process.env.GVS_TUI_LOG = '1'
    setRunLogDisabled(false)
    mock = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      code: 500, error_code: 'OPERATION_FAILED', msg: '操作暂时未能完成，请稍后重试。',
    }, { status: 500 }))
    const client = new GwClient('https://gateway.example', 'PRIVATE_KEY')
    await expect(client.invoke('iqcn', 'audio', { planId: 'plan', audioId: 'chosen' }))
      .rejects.toThrow('操作暂时未能完成')
    const log = readFileSync(process.env.GVS_TUI_LOG_PATH, 'utf8')
    expect(log).toContain('invoke iqcn/audio')
    expect(log).toContain('http=500 code=500 error_code=OPERATION_FAILED')
    expect(log).not.toContain('PRIVATE_KEY')
  } finally {
    if (previousPath === undefined) delete process.env.GVS_TUI_LOG_PATH
    else process.env.GVS_TUI_LOG_PATH = previousPath
    if (previousLog === undefined) delete process.env.GVS_TUI_LOG
    else process.env.GVS_TUI_LOG = previousLog
    setRunLogDisabled(!logging)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unknown gateway HTML stays out of display while the status remains available internally', async () => {
  mock = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>private-host token=secret</html>', { status: 502 }))
  const client = new GwClient('https://gateway.example', 'key')
  try { await client.keyInfo(); throw new Error('expected failure') }
  catch (error) {
    expect(userMessage(error)).toContain('服务暂时不可用')
    expect(userMessage(error)).not.toMatch(/private|secret|html/)
  }
})

test('localized unsupported report action allows search without further report retries', async () => {
  const actions: string[] = []
  mock = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = JSON.parse(String(init?.body))
    actions.push(request.action)
    if (request.action === 'report') return Response.json({ code: 400, msg: '当前服务暂不支持此操作。', error_code: 'ACTION_UNSUPPORTED' }, { status: 400 })
    return Response.json({ code: 0, data: { list: [] } })
  }, { preconnect: fetch.preconnect }))
  const client = new GwClient('https://gateway.example', 'key', () => ({ tencentMode: 'tv', tencentObservations: true }) as never)
  await client.invoke('tencent', 'search', { q: '剧名' })
  await client.invoke('tencent', 'search', { q: '另一个' })
  expect(actions).toEqual(['report', 'search', 'search'])
})
