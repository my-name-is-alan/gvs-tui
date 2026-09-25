import '@fontsource/noto-sans-sc/400.css'
import '@fontsource/noto-sans-sc/500.css'
import '@fontsource/noto-sans-sc/700.css'
import '@fontsource/noto-sans-sc/900.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource-variable/bricolage-grotesque/index.css'
import './styles.css'
import { createApp } from 'vue'
import App from './App.vue'
import { initStore } from './store'

initStore()
createApp(App).mount('#app')
