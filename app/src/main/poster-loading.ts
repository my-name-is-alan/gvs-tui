/** Reserve each permit until it is handed to the next waiter, including on failure. */
export function createPosterQueue(limit = 6): <T>(run: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid poster concurrency')
  let active = 0
  const waiters: Array<() => void> = []
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active < limit) active++
    else await new Promise<void>(resolve => waiters.push(resolve))
    try {
      return await run()
    } finally {
      const next = waiters.shift()
      if (next) next()
      else active--
    }
  }
}

/** A 640px cover is sufficient for both desktop cards and the detail poster. */
export function posterResizeSize(width: number, height: number, bytes: number): { width: number; height: number } | null {
  if (width <= 0 || height <= 0) return null
  const scale = Math.min(1, 640 / width, 1280 / height)
  if (scale === 1 && bytes <= 512 * 1024) return null
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}
