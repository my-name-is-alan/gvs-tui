import type { Scene } from '../types'
export type Location = { scene: Scene; cursor: number; payload?: unknown }
export class Navigation {
  private stack: Location[] = []
  push(scene: Scene, cursor: number, payload?: unknown) {
    this.stack.push({ scene, cursor, payload })
  }
  pop(): Location {
    return this.stack.pop() ?? { scene: 'workspace', cursor: 0 }
  }
  clear() {
    this.stack = []
  }
}
export function moveCursor(
  cursor: number,
  key: string,
  total: number,
  page: number,
  columns = 1,
) {
  const last = Math.max(0, total - 1)
  const delta =
    key === 'up'
      ? -columns
      : key === 'down'
        ? columns
        : key === 'left'
          ? -1
          : key === 'right'
            ? 1
            : key === 'pageup'
              ? -page
              : key === 'pagedown'
                ? page
                : 0
  return key === 'home'
    ? 0
    : key === 'end'
      ? last
      : Math.max(0, Math.min(last, cursor + delta))
}
