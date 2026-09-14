import { existsSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Job = { id: number; title: string; status: string; pct: number; log: string; err: string }
export type Row = { title: string; id: string; sub: string }
export type Episode = { title: string; vid: string; number: number; selected: boolean }
export type Quality = { label: string; title: string; size: number; width: number; height: number; codec: string; drm: string }
export type TMDBHit = { id: number; name: string; title: string; year: number; overview?: string }
export type Snapshot = {
  scene: string
  host: string
  status: string
  tunnelOk: boolean
  tunnelError?: string
  cursor: number
  providerIndex: number
  qualityIndex: number
  providers?: string[]
  homeItems?: string[]
  rows?: Row[]
  episodes?: Episode[]
  qualities?: Quality[]
  tmdbHits?: TMDBHit[]
  jobs?: Job[]
  settings?: { label: string; value: string }[]
  detailTitle?: string
  pendingCount?: number
  query?: string
  hostInput?: string
  hostFocused: boolean
  keyFocused: boolean
  keyConfigured: boolean
  editField?: string
  editValue?: string
  qrAscii?: string
  footer?: string
}

type Request = { type: 'key' | 'set' | 'quit'; name?: string; field?: string; value?: string; ctrl?: boolean; alt?: boolean; shift?: boolean }

const root = process.env.GVS_TUI_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundledBridge = resolve(root, 'bin', process.platform === 'win32' ? 'gvs-tui-bridge.exe' : 'gvs-tui-bridge')
const bridgePath = process.env.GVS_TUI_BRIDGE ?? (existsSync(bundledBridge) ? bundledBridge : undefined)
const command = bridgePath ? bridgePath : 'go'
const args = bridgePath ? ['--vue-bridge'] : ['run', './cmd/tui', '--vue-bridge']

export class Bridge {
  private readonly child: ChildProcess
  private readonly listeners = new Set<(snapshot: Snapshot) => void>()
  snapshot: Snapshot | null = null

  constructor() {
    this.child = spawn(command, args, { cwd: root, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
    const lines = createInterface({ input: this.child.stdout! })
    lines.on('line', (line) => {
      try {
        const next = JSON.parse(line) as Snapshot
        this.snapshot = next
        for (const listener of this.listeners) listener(next)
      } catch {
        // A malformed line must not take down the terminal UI.
      }
    })
  }

  onSnapshot(listener: (snapshot: Snapshot) => void) {
    this.listeners.add(listener)
    if (this.snapshot) listener(this.snapshot)
    return () => this.listeners.delete(listener)
  }

  send(request: Request) {
    if (this.child.stdin && !this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(request)}\n`)
  }

  key(name: string, modifiers: Pick<Request, 'ctrl' | 'alt' | 'shift'> = {}) {
    this.send({ type: 'key', name, ...modifiers })
  }

  set(field: string, value: string) {
    this.send({ type: 'set', field, value })
  }

  close() {
    this.send({ type: 'quit' })
    this.child.kill()
  }
}
