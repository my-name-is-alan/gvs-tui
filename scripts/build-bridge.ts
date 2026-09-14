import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const extension = process.platform === 'win32' ? '.exe' : ''
const output = join('bin', `gvs-tui-bridge${extension}`)
mkdirSync('bin', { recursive: true })

const result = spawnSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', output, './cmd/tui'], {
  stdio: 'inherit',
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
