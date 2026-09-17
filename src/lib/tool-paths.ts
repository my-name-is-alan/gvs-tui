import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Both src/lib and the compiled dist use the checkout's shared bin directory.
 * Prefer the repository over stale bin folders from an earlier packaged build.
 */
export function toolDirectoryFrom(modulePath: string): string {
  const here = dirname(modulePath)
  if (existsSync(join(here, '..', '..', 'package.json'))) return join(here, '..', '..', 'bin')
  if (existsSync(join(here, '..', 'package.json'))) return join(here, '..', 'bin')
  return join(here, 'bin')
}

export function tuiBinDir(): string {
  return toolDirectoryFrom(fileURLToPath(import.meta.url))
}
