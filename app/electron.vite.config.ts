import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

const LIB = resolve(__dirname, '../src/lib')

/**
 * TUI 的 lib 直接复用；只有两处依赖 Bun / 源码目录布局，构建时换成桌面端实现：
 *   proxy.ts      Bun fetch 的 `proxy` 选项 → Electron net.fetch（跟随系统代理）
 *   tool-paths.ts 按源码位置找 bin/ → 开发用仓库 bin/，安装包用 resources/bin
 */
function tuiShims(): Plugin {
  const swap: Record<string, string> = {
    [resolve(LIB, 'proxy.ts')]: resolve(__dirname, 'src/main/shims/proxy.ts'),
    [resolve(LIB, 'tool-paths.ts')]: resolve(__dirname, 'src/main/shims/tool-paths.ts'),
  }
  return {
    name: 'gvs-tui-shims',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !source.startsWith('.')) return null
      const hit = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (!hit) return null
      const target = swap[resolve(hit.id)]
      return target ?? null
    },
  }
}

/** Chromium 只用 woff2；fontsource 附带的 woff 回退只会让安装包多 12MB。 */
function woff2Only(): Plugin {
  return {
    name: 'gvs-woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@fontsource') || !id.endsWith('.css')) return null
      return code.replace(/,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g, '')
    },
  }
}

export default defineConfig({
  main: {
    plugins: [tuiShims()],
    resolve: { alias: { '@tui': LIB, '@shared': resolve(__dirname, 'src/shared') } },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } },
  },
  preload: {
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared'), '@': resolve(__dirname, 'src/renderer/src') } },
    plugins: [woff2Only(), vue()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } },
  },
})
