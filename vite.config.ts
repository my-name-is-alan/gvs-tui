import { defineConfig } from 'vite'
import vueTermui from 'vue-termui/vite'

export default defineConfig({
  plugins: [vueTermui()],
  build: { rollupOptions: { input: 'main.ts', output: { entryFileNames: 'main.js' } } },
})
