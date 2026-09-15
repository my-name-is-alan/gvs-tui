// Bun loader for `.vue` single-file components, so the preview harness can
// import the real UI outside of Vite. `@vue/compiler-sfc` is installed as part
// of the Vue toolchain (it is what @vitejs/plugin-vue compiles with), so this
// adds no dependency of its own.
import { plugin } from 'bun'
import { createHash } from 'node:crypto'
import { compileScript, parse } from '@vue/compiler-sfc'

plugin({
  name: 'gvs-vue-sfc',
  setup(build) {
    build.onLoad({ filter: /\.vue$/ }, async (args) => {
      const source = await Bun.file(args.path).text()
      const { descriptor, errors } = parse(source, { filename: args.path })
      if (errors.length) throw new Error(`[vue-sfc] ${args.path}: ${errors[0]?.message}`)
      if (!descriptor.scriptSetup) throw new Error(`[vue-sfc] ${args.path}: <script setup> is required`)
      const id = createHash('sha256').update(args.path).digest('hex').slice(0, 8)
      const compiled = compileScript(descriptor, { id, inlineTemplate: true })
      const lang = descriptor.scriptSetup.lang ?? 'js'
      return { contents: compiled.content, loader: lang === 'ts' ? 'ts' : 'js' }
    })
  },
})
