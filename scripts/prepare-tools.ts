// Optional preflight; Runtime also prepares missing tools on startup.
import { ensureTools, tuiBinDir } from '../src/lib/tools.ts'

await ensureTools(console.log)
console.log(`媒体工具已准备：${tuiBinDir()}`)
