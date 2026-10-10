import { expect, mock, test } from 'bun:test'
import { join } from 'node:path'

const state = { isPackaged: false }
mock.module(join(import.meta.dir, '../../app/node_modules/electron'), () => ({ app: {
  get isPackaged() { return state.isPackaged },
  getAppPath: () => '/fixture/gvs/app',
  getPath: () => '/fixture/user-data',
} }))
const { iqcnLocalPath, tuiBinDir } = await import('../../app/src/main/shims/tool-paths.ts')

test('development IQCN helper uses the checkout tools', () => {
  state.isPackaged = false
  expect(iqcnLocalPath()).toBe(join('/fixture/gvs/bin', process.platform === 'win32' ? 'iqcn-local.exe' : 'iqcn-local'))
})

test('packaged IQCN helper uses resources, separately from writable media wrappers', () => {
  const previous = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { value: '/fixture/resources', configurable: true })
  state.isPackaged = true
  try {
    expect(iqcnLocalPath()).toBe(join('/fixture/resources/bin', process.platform === 'win32' ? 'iqcn-local.exe' : 'iqcn-local'))
    expect(tuiBinDir()).toBe(join(process.platform === 'win32' ? '/fixture/resources' : '/fixture/user-data', 'bin'))
  } finally {
    state.isPackaged = false
    if (previous) Object.defineProperty(process, 'resourcesPath', previous)
    else Reflect.deleteProperty(process, 'resourcesPath')
  }
})
