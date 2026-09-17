import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { toolDirectoryFrom } from './tool-paths.ts'

test('source and compiled app share root tools even with stale dist/bin', () => {
  const root = mkdtempSync(join(tmpdir(), 'gvs-tool-root-'))
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"gvs-tui"}')
    mkdirSync(join(root, 'src', 'lib'), { recursive: true })
    mkdirSync(join(root, 'dist', 'bin'), { recursive: true })
    writeFileSync(join(root, 'dist', 'package.json'), '{"name":"old-build"}')
    expect(resolve(toolDirectoryFrom(join(root, 'src', 'lib', 'tool-paths.ts')))).toBe(join(root, 'bin'))
    expect(resolve(toolDirectoryFrom(join(root, 'dist', 'main.js')))).toBe(join(root, 'bin'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
