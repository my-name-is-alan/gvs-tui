import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Source tree and portable dist both locate tools relative to the app, never cwd. */
export function tuiBinDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const adjacent = join(here, 'bin')
  if (existsSync(adjacent)) return adjacent
  if (existsSync(join(here, '..', '..', 'package.json'))) return join(here, '..', '..', 'bin')
  return adjacent
}
