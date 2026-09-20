import { defineConfig } from 'vite'
import vueTermui from 'vue-termui/vite'
import * as compiler from 'vue/compiler-sfc'

export default defineConfig({
  // vue-termui can import the SSR entry before plugin-vue's client buildStart.
  // Supply the compiler eagerly so startup never races its initialization.
  plugins: [vueTermui({ vue: { compiler } })],
  // Rolldown (vite build, web target) replaces every process.env access with {}.
  // That breaks inheritedProxyUrl() / reexecWithoutProxy() in production: CDN
  // downloads stay on Clash. Keep a live Node/Bun env object instead.
  // See: v0.2.3 regression — dev OK, build product broken.
  define: {
    'process.env': 'globalThis.process.env',
  },
  build: { rollupOptions: { input: 'main.ts', output: { entryFileNames: 'main.js' } } },
})
