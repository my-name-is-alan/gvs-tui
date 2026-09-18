import { spawn } from 'bun'
// Same Runtime, renderer and keyboard handlers as production; isolated fixtures.
const child = spawn(['bun', '--bun', 'dist/main.js'], {
  cwd: import.meta.dir + '/..',
  env: { ...process.env, GVS_PREVIEW: 'interactive' },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exit(await child.exited)
