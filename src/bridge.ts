import { Runtime } from './runtime.ts'
import type { Snapshot } from './types.ts'

export type { Job, Row, Episode, Quality, TMDBHit, Snapshot } from './types.ts'

export class Bridge {
  private readonly runtime = new Runtime()
  snapshot: Snapshot | null

  constructor() {
    this.snapshot = this.runtime.snapshot
  }

  onSnapshot(listener: (snapshot: Snapshot) => void) {
    return this.runtime.onSnapshot(listener)
  }

  key(name: string, modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) {
    this.runtime.handleKey(name, modifiers)
  }

  set(field: string, value: string) {
    this.runtime.set(field, value)
  }

  close() {
    this.runtime.close()
  }
}
