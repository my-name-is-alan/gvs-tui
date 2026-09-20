import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moveFileSync } from './file-move.ts'

test('moveFileSync moves completed files across temp and library volumes', () => {
  const sourceDir = mkdtempSync(join(process.cwd(), '.move-src-'))
  const destDir = mkdtempSync(join(tmpdir(), 'gvs-move-dst-'))
  const source = join(sourceDir, 'artifact.bin')
  const destination = join(destDir, 'artifact.bin')
  try {
    writeFileSync(source, 'completed artifact')
    moveFileSync(source, destination)
    expect(readFileSync(destination, 'utf8')).toBe('completed artifact')
    expect(existsSync(source)).toBe(false)
  } finally {
    rmSync(sourceDir, { recursive: true, force: true })
    rmSync(destDir, { recursive: true, force: true })
  }
})
