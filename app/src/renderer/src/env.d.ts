/// <reference types="vite/client" />
import type { GvsBridge } from '@shared/api'

declare global {
  interface Window {
    gvs: GvsBridge
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}
