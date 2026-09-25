import { contextBridge, ipcRenderer } from 'electron'
import type { GvsBridge } from '@shared/api'

const bridge: GvsBridge = {
  call: (async (method: string, ...args: unknown[]) => {
    const r = (await ipcRenderer.invoke('gvs:call', method, args)) as { ok: boolean; data?: unknown; error?: string }
    if (!r.ok) throw new Error(r.error ?? '未知错误')
    return r.data
  }) as GvsBridge['call'],
  on: (event, cb) => {
    const channel = `gvs:${event}`
    const listener = (_e: unknown, payload: unknown) => cb(payload as never)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
}

contextBridge.exposeInMainWorld('gvs', bridge)
