import { describe, expect, test } from 'bun:test'
import { envWithoutProxy, inheritedProxyUrl, isProxyEnvKey } from './proxy.ts'

describe('inheritedProxyUrl', () => {
  test('picks HTTPS_PROXY when GVS_PROXY is unset', () => {
    expect(inheritedProxyUrl({ HTTPS_PROXY: 'http://127.0.0.1:7897' })).toBe('http://127.0.0.1:7897')
  })
  test('already re-execed: GVS_PROXY blocks another spawn', () => {
    expect(
      inheritedProxyUrl({
        GVS_PROXY: 'http://127.0.0.1:7897',
        HTTPS_PROXY: 'http://127.0.0.1:7897',
      }),
    ).toBe('')
  })
  test('empty values are ignored', () => {
    expect(inheritedProxyUrl({ HTTP_PROXY: '  ', https_proxy: '' })).toBe('')
  })
})

describe('envWithoutProxy', () => {
  test('drops both cases of proxy vars and stores GVS_PROXY', () => {
    const env = envWithoutProxy(
      {
        HTTPS_PROXY: 'http://127.0.0.1:7897',
        https_proxy: 'http://127.0.0.1:7897',
        PATH: '/usr/bin',
        NO_PROXY: 'localhost',
      },
      'http://127.0.0.1:7897',
    )
    expect(env.GVS_PROXY).toBe('http://127.0.0.1:7897')
    expect(env.PATH).toBe('/usr/bin')
    expect(env.NO_PROXY).toBe('localhost')
    expect(Object.keys(env).some(isProxyEnvKey)).toBe(false)
  })
})
