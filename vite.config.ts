import { defineConfig } from 'vite'
import vueTermui from 'vue-termui/vite'
import * as compiler from 'vue/compiler-sfc'

export default defineConfig({
  // vue-termui can import the SSR entry before plugin-vue's client buildStart.
  // Supply the compiler eagerly so startup never races its initialization.
  plugins: [vueTermui({ vue: { compiler } })],
  build: { rollupOptions: { input: 'main.ts', output: { entryFileNames: 'main.js' } } },
})
