import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createServer, type Plugin } from 'vite'
import config from '../vite.config'

test('dev compiles the root component before the client buildStart hook', async () => {
  // Keep the real compiler configuration, but do not launch the terminal app.
  const plugins = (config.plugins ?? []).flat()
    .filter(plugin => (plugin as Plugin)?.name !== 'vue-termui:dev')
  const server = await createServer({
    ...config,
    configFile: false,
    root: resolve(import.meta.dir, '..'),
    plugins,
    logLevel: 'silent',
    server: { middlewareMode: false, watch: null, ws: false },
  })

  try {
    // vue-termui can import the app before listen() starts the client plugins.
    // Trigger that same early SSR compilation without executing app code.
    const result = await server.environments.ssr.transformRequest('/src/Root.vue')
    expect(result?.code.length).toBeGreaterThan(0)
  } finally {
    await server.close()
  }
}, 20_000)
