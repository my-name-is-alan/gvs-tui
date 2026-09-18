// 删掉 dev server 的编译缓存再起（怀疑缓存异常时用）。
// `compiler.parse` 空值由 vite.config.ts 提前提供编译器解决，不能靠清缓存保证。
//   bun run dev:clean
//
// 注意：**先把正在跑的 dev server 停掉**再清。vite 在盯着自己这份缓存目录，
// 运行中删掉它会让进程直接退出（实测过一次）。
import { rmSync } from 'node:fs'

const targets = ['node_modules/.vite', 'node_modules/.vite-temp']
for (const p of targets) {
  try {
    rmSync(p, { recursive: true, force: true })
    console.log(`cleared ${p}`)
  } catch (e) {
    console.log(`skip ${p}: ${e instanceof Error ? e.message : e}`)
  }
}
