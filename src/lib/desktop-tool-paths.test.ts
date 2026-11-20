import { expect, mock, test } from 'bun:test'
import { join } from 'node:path'

const state = { isPackaged: false }
// Mock the bare specifier: app/node_modules is absent in the TUI CI jobs, so a
// path-based mock alone leaves the shim's `import 'electron'` unresolvable.
const electron = () => ({ app: {
  get isPackaged() { return state.isPackaged },
  getAppPath: () => '/fixture/gvs/app',
  getPath: () => '/fixture/user-data',
} })
mock.module('electron', electron)
mock.module(join(import.meta.dir, '../../app/node_modules/electron'), electron)
const { iqcnLocalPath, mobile42DecodePath, m3u8dlPath, tuiBinDir } = await import('../../app/src/main/shims/tool-paths.ts')

test('development managed downloader and IQCN helper use the checkout tools', () => {
  state.isPackaged = false
  expect(iqcnLocalPath()).toBe(join('/fixture/gvs/bin', process.platform === 'win32' ? 'iqcn-local.exe' : 'iqcn-local'))
  expect(mobile42DecodePath()).toBe(join('/fixture/gvs/bin', process.platform === 'win32' ? 'tencent-mobile42-decode.exe' : 'tencent-mobile42-decode'))
  expect(m3u8dlPath()).toBe(join('/fixture/gvs/bin', process.platform === 'win32' ? 'N_m3u8DL-RE.exe' : 'N_m3u8DL-RE'))
})

test('packaged downloader and IQCN helper use resources instead of stale writable caches', () => {
  const previous = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { value: '/fixture/resources', configurable: true })
  state.isPackaged = true
  try {
    expect(iqcnLocalPath()).toBe(join('/fixture/resources/bin', process.platform === 'win32' ? 'iqcn-local.exe' : 'iqcn-local'))
    expect(mobile42DecodePath()).toBe(join('/fixture/resources/bin', process.platform === 'win32' ? 'tencent-mobile42-decode.exe' : 'tencent-mobile42-decode'))
    expect(m3u8dlPath()).toBe(join('/fixture/resources/bin', process.platform === 'win32' ? 'N_m3u8DL-RE.exe' : 'N_m3u8DL-RE'))
    expect(tuiBinDir()).toBe(join(process.platform === 'win32' ? '/fixture/resources' : '/fixture/user-data', 'bin'))
  } finally {
    state.isPackaged = false
    if (previous) Object.defineProperty(process, 'resourcesPath', previous)
    else Reflect.deleteProperty(process, 'resourcesPath')
  }
})
