// Ad-hoc provider probe: call the gateway the way the TUI does and print the
// *shape* of the response, so the UI can be built against real payloads.
//   bun run scripts/probe-provider.ts <provider> <action> '<json input>' [--full]
//   PROBE_HOST=http://127.0.0.1:8080 ...   # probe a local gateway instead
import { GwClient } from '../src/lib/client.ts'
import { loadConfig } from '../src/lib/config.ts'

const argv = process.argv.slice(2)
const full = argv.includes('--full')
const pathArg = argv.findIndex((a) => a === '--path')
const pick = pathArg >= 0 ? argv[pathArg + 1] : ''
const [provider, action, inputJson] = argv.filter((a) => a !== '--full' && a !== '--path' && a !== pick)

function atPath(data: unknown, path: string): unknown {
  let cur: unknown = data
  for (const key of path.split('.').filter(Boolean)) {
    if (Array.isArray(cur)) {
      const n = Number.parseInt(key, 10)
      cur = Number.isFinite(n) ? cur[n] : cur.map((x) => (x as Record<string, unknown>)?.[key])
    } else if (cur && typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  return cur
}

function brief(v: unknown, depth = 0): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) {
    if (!v.length) return '[]'
    const head = v[0]
    if (head && typeof head === 'object') return `[${v.length} × {${Object.keys(head as object).join(', ')}}]`
    return `[${v.length}] ${JSON.stringify(v.slice(0, 4))}`
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v as object)
    return `{${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''}}`
  }
  const s = String(v)
  return s.length > 90 ? `${s.slice(0, 90)}…(${s.length})` : s
}

const cfg = loadConfig()
const cli = new GwClient(process.env.PROBE_HOST ?? cfg.host, cfg.key)
const input = inputJson ? (JSON.parse(inputJson) as Record<string, unknown>) : {}

console.log(`→ ${process.env.PROBE_HOST ?? cfg.host}  ${provider}/${action}  ${JSON.stringify(input)}`)
const started = Date.now()
try {
  const data = await cli.invoke(provider, action, input)
  console.log(`← ${Date.now() - started}ms, ${JSON.stringify(data).length} bytes`)
  if (pick) {
    console.log(JSON.stringify(atPath(data, pick), null, 2).slice(0, 8000))
  } else {
    for (const [k, v] of Object.entries(data)) console.log(`  ${k}: ${brief(v)}`)
    if (full) console.log(JSON.stringify(data, null, 2).slice(0, 12_000))
  }
} catch (e) {
  console.log(`✗ ${Date.now() - started}ms  ${e instanceof Error ? e.message : e}`)
}
process.exit(0)
