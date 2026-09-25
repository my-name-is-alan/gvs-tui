import { mkdirSync, mkdtempSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Working directory for a download or mux, beside `anchor` so the bytes stay
 * on the same volume as the user's library. System temp is the fallback when
 * that folder cannot be created.
 */
export function scratchDir(anchor: string, prefix: string): string {
  const base = join(dirname(anchor), '.gvs-tmp')
  try {
    mkdirSync(base, { recursive: true })
    return mkdtempSync(join(base, prefix))
  } catch {
    return mkdtempSync(join(tmpdir(), prefix))
  }
}

/** Remove a scratch directory and the `.gvs-tmp` parent when nothing else is using it. */
export function removeScratch(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  try { rmdirSync(dirname(dir)) } catch { /* another download still has a folder here */ }
}
