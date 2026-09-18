import { Runtime } from './runtime.ts'
import { demoSnapshot } from './lib/demo.ts'
import type { Snapshot } from './types.ts'

export type { Job, Row, Episode, Quality, TMDBHit, Snapshot, StatusKind } from './types.ts'

/**
 * `GVS_PREVIEW=<scene>` swaps the live gateway for canned data, so the UI can
 * be opened (and screenshot-tested) without a key, a gateway, or a network.
 * Keys become no-ops; see `bun run preview`.
 */
function previewRequest(): string {
  return (process.env.GVS_PREVIEW ?? '').trim()
}

export class Bridge {
  private readonly runtime: Runtime | null
  snapshot: Snapshot
  /** True when running on canned data — the shell shows a `PREVIEW` chip. */
  readonly preview: boolean

  constructor() {
    const preview = previewRequest()
    if (preview && preview !== 'interactive') {
      const raw = Number.parseInt(process.env.GVS_PREVIEW_CURSOR ?? '0', 10)
      this.runtime = null
      this.preview = true
      this.snapshot = demoSnapshot(preview, Number.isFinite(raw) ? raw : 0)
      return
    }
    this.runtime = new Runtime({simulate:preview === 'interactive'})
    this.preview = false
    this.snapshot = this.runtime.snapshot
  }

  onSnapshot(listener: (snapshot: Snapshot) => void): () => void {
    if (!this.runtime) {
      listener(this.snapshot)
      return () => {}
    }
    return this.runtime.onSnapshot(listener)
  }

  resize(width:number,height:number):void {this.runtime?.resize(width,height)}

  key(name: string, modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}): void {
    this.runtime?.handleKey(name, modifiers)
  }

  set(field: string, value: string): void {
    this.runtime?.set(field, value)
  }

  /** OpenTUI's clock, not Node setInterval — Win10 conhost starves the latter. */
  tickQR(): void {
    this.runtime?.tickQR()
  }

  close(): void {
    this.runtime?.close()
  }
}
