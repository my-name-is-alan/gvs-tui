// Hold a real home-broadband tunnel to a gateway and serve its egress requests
// from this machine, exactly like the TUI does. Used when probing providers
// (youku/tencent) that must go out from a residential IP.
//   PROBE_HOST=http://127.0.0.1:8080 TUNNEL_SECONDS=120 bun run scripts/serve-tunnel.ts
import { runTunnel } from '../src/lib/tunnel.ts'
import { loadConfig } from '../src/lib/config.ts'

const cfg = loadConfig()
const host = process.env.PROBE_HOST ?? cfg.host
const seconds = Number(process.env.TUNNEL_SECONDS ?? 60)
const abort = new AbortController()

const started = Date.now()
const at = () => `${String(Date.now() - started).padStart(6)}ms`
console.log(`${at()}  dialling ${host} ...`)

runTunnel(host, cfg.key, (ok, err) => {
  console.log(`${at()}  ${ok ? 'tunnel UP' : `tunnel down (${err || 'closed'})`}`)
}, abort.signal)

await new Promise((r) => setTimeout(r, seconds * 1000))
abort.abort()
process.exit(0)
