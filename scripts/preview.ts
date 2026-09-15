// Renders every screen of the TUI off-screen and writes the resulting text
// frames to preview/. No gateway, no API key, no terminal required.
//
//   bun run preview                    # every scene at 100x30
//   bun run preview jobs detail        # selected scenes
//   PREVIEW_SIZE=140x40 bun run preview
//
// The frames are plain text, so they diff cleanly in review.
import './vue-sfc.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { defineComponent, h } from '@vue/runtime-core'
import { createApp, useRenderer } from 'vue-termui'
import { DEMO_SCENES } from '../src/lib/demo.ts'

type Renderer = {
  currentRenderBuffer: { getRealCharBytes: (trim: boolean) => Uint8Array }
  destroy: () => void
}

const [cols, rows] = (process.env.PREVIEW_SIZE ?? '100x30')
  .split('x')
  .map((part) => Number.parseInt(part, 10))
const width = Number.isFinite(cols) && cols > 0 ? cols : 100
const height = Number.isFinite(rows) && rows > 0 ? rows : 30

/** Cursor positions that show selection, scrolled lists and long titles. */
const CURSOR: Record<string, number> = {
  home: 1,
  results: 4,
  detail: 20,
  quality: 1,
  tmdb: 1,
  settings: 3,
}

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const scenes = requested.length ? requested : DEMO_SCENES

const outDir = join(import.meta.dir, '..', 'preview')
mkdirSync(outDir, { recursive: true })

async function renderScene(scene: string): Promise<string> {
  process.env.GVS_PREVIEW = scene
  process.env.GVS_PREVIEW_CURSOR = String(CURSOR[scene] ?? 0)

  let renderer: Renderer | null = null
  const Probe = defineComponent({
    setup() {
      renderer = useRenderer() as unknown as Renderer
      return () => h(RootComponent)
    },
  })

  const stdin = new PassThrough() as unknown as NodeJS.ReadStream
  const stdout = new Writable({ write(_chunk, _enc, done) { done() } }) as unknown as NodeJS.WriteStream
  const app = await createApp(Probe, null, {
    stdin,
    stdout,
    width,
    height,
    exitOnCtrlC: false,
    consoleMode: 'disabled',
    screenMode: 'main-screen',
  })
  app.mount()
  await new Promise((resolve) => setTimeout(resolve, 250))

  const buffer = renderer!.currentRenderBuffer.getRealCharBytes(true)
  const frame = new TextDecoder().decode(buffer)

  app.unmount()
  renderer!.destroy()
  return frame.replace(/\s+$/, '')
}

const RootComponent = (await import('../src/Root.vue')).default as Parameters<typeof h>[0]

const frames: string[] = []
for (const scene of scenes) {
  const frame = await renderScene(scene)
  const title = `${scene}  (${width}x${height})`
  const file = join(outDir, `${scene}-${width}x${height}.txt`)
  writeFileSync(file, `${title}\n${frame}\n`)
  frames.push(`\n──────── ${title} ────────\n${frame}`)
}

process.stdout.write(`${frames.join('\n')}\n`)
process.exit(0)
