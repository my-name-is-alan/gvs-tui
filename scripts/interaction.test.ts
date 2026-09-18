import './vue-sfc.ts'
import { test, expect } from 'bun:test'
import { PassThrough, Writable } from 'node:stream'
import { defineComponent, h } from '@vue/runtime-core'
import { createApp, useRenderer } from 'vue-termui'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
test('interactive simulation responds to real terminal keys and edits inside search input', async () => {
  process.env.GVS_PREVIEW = 'interactive'
  const Root = (await import('../src/Root.vue')).default
  let renderer: any
  const Probe = defineComponent({
    setup() {
      renderer = useRenderer()
      return () => h(Root)
    },
  })
  const stdin = new PassThrough()
  const stdout = new Writable({
    write(_chunk, _enc, done) {
      done()
    },
  })
  const app = await createApp(Probe, null, {
    stdin: stdin as any,
    stdout: stdout as any,
    width: 80,
    height: 24,
    exitOnCtrlC: false,
    consoleMode: 'disabled',
    screenMode: 'main-screen',
  })
  const errors: unknown[] = []
  app.config.errorHandler = (e) => errors.push(e)
  const frame = () =>
    new TextDecoder().decode(
      renderer.currentRenderBuffer.getRealCharBytes(true),
    )
  const press = async (key: string) => {
    stdin.write(key)
    await Bun.sleep(150)
  }
  try {
    app.mount()
    await Bun.sleep(350)
    expect(frame()).toContain('平台推荐')
    await press('\x1b2')
    expect(frame()).toContain('腾讯')
    await press('\x1b3')
    expect(frame()).toContain('红果')
    await press('\x1b1')
    expect(frame()).toContain('优酷')
    await press('\x1bOQ')
    expect(frame()).toContain('搜索')
    await press('abcd')
    await press('\x1b[D')
    await press('\x7f')
    await press('X')
    expect(frame()).toContain('abXd')
    await press('\r')
    expect(frame()).toContain('搜索结果')
    await press('\r')
    expect(frame()).toContain('演示')
    await press('\r')
    expect(frame()).toContain('画质')
    await press('\r')
    expect(frame()).toContain('确认下载')
    mkdirSync(join(import.meta.dir, '../preview'), { recursive: true })
    writeFileSync(
      join(import.meta.dir, '../preview/interactive-confirm-80x24.txt'),
      frame(),
    )
    await press('\x1b')
    expect(frame()).toContain('画质')
    expect(errors).toHaveLength(0)
  } finally {
    app.unmount()
    renderer?.destroy()
    delete process.env.GVS_PREVIEW
  }
}, 10000)
