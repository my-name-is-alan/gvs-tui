// Probe /v1/tunnel as a real WebSocket. TUNNEL_URL picks Cloudflare vs local origin.
const base = (process.env.TUNNEL_URL ?? 'https://gvs.videohack.shop').replace(/\/+$/, '')
const key = process.env.TUNNEL_KEY ?? 'sk_live_dev12345678.devsecretdevsecretdevsecretdevsecret'
const seconds = Number(process.env.TUNNEL_SECONDS ?? 12)

const u = new URL(base)
u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
u.pathname = '/v1/tunnel'
u.search = ''
const url = u.toString()
const started = Date.now()
const at = () => `${String(Date.now() - started).padStart(6)}ms`

type HeaderWS = {
  new (url: string, opts?: { headers?: Record<string, string> }): WebSocket
}

console.log(`=== ${url} (${seconds}s${process.env.TUNNEL_ECHO ? ', answering req frames' : ' of silence'}) ===`)

const WS = WebSocket as unknown as HeaderWS
const ws = new WS(url, { headers: { Authorization: `Bearer ${key}` } })
let opened = false

ws.addEventListener('open', () => {
  opened = true
  console.log(`${at()}  OPEN  websocket`)
})
ws.addEventListener('message', (ev) => {
  const text = typeof ev.data === 'string' ? ev.data : String(ev.data)
  console.log(`${at()}  RECV  ${text.slice(0, 120)}`)
  if (!process.env.TUNNEL_ECHO) return
  let f: { t?: string; id?: string; url?: string }
  try {
    f = JSON.parse(text) as { t?: string; id?: string; url?: string }
  } catch {
    return
  }
  if (f.t === 'ping') {
    ws.send(JSON.stringify({ t: 'pong' }))
    return
  }
  if (f.t !== 'req') return
  const body = Buffer.from(`tunnelled from ${process.env.COMPUTERNAME ?? 'this machine'} → ${f.url ?? ''}`).toString('base64')
  ws.send(JSON.stringify({ t: 'res', id: f.id, status: 200, header: { 'content-type': ['text/plain'] }, body }))
  console.log(`${at()}  ECHO  answered ${f.id} for ${f.url}`)
})
ws.addEventListener('error', () => console.log(`${at()}  ERROR websocket`))
ws.addEventListener('close', (ev) => console.log(`${at()}  CLOSE code=${ev.code} reason=${ev.reason || '(none)'}`))

const { promise: wait, resolve: done } = Promise.withResolvers<void>()
setTimeout(done, seconds * 1000)
await wait
console.log(`${at()}  final: open=${opened} readyState=${ws.readyState}`)
ws.close()
process.exit(0)
