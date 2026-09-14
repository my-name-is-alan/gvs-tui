import { createApp } from 'vue-termui'
import Root from './Root.vue'

const app = await createApp(Root, null, { exitOnCtrlC: true })
app.mount()
await app.waitUntilExit()
