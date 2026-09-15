// 探测「同一个 Yk-Sign 时好时坏」：是网关多副本共享存储问题，还是本地问题。
//   bun run scripts/check-sticky.ts [次数]
import { GwClient } from '../src/lib/client.ts'
import { loadConfig } from '../src/lib/config.ts'

const cfg = loadConfig()
const cli = new GwClient(process.env.PROBE_HOST ?? cfg.host, cfg.key)
const H = { 'Yk-Sign': cfg.youkuSign }
const N = Number(process.argv[2] ?? 6)

async function once(action: string, input: Record<string, unknown>): Promise<string> {
  try {
    await cli.invoke('youku', action, input, H)
    return 'OK'
  } catch (e) {
    return `ERR ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`
  }
}

console.log(`网关 ${cfg.host} · 签名 ${cfg.youkuSign.slice(0, 8)}… · ${N} 次\n`)
for (let i = 1; i <= N; i++) {
  const cred = await once('cred', { method: 'info' })
  const acct = await once('account', { method: 'risk' })
  process.stdout.write(`#${i}  cred.info=${cred.padEnd(14)} account.risk=${acct}\n`)
}
