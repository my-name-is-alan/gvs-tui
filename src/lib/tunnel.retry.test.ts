import { expect, test } from 'bun:test'
import { tunnelRetryWait } from './tunnel.ts'

test('a replaced tunnel waits before taking the slot back', () => {
  expect(tunnelRetryWait({ opened: true, code: 4000, reason: 'replaced' }, 1, '')).toBe(30_000)
})

test('a restart closes and reconnects quickly', () => {
  expect(tunnelRetryWait({ opened: true, code: 1001, reason: 'restart' }, 1, '')).toBe(1_000)
  expect(tunnelRetryWait({ opened: true, code: 1006, reason: '' }, 1, '')).toBe(1_000)
})

test('a refused handshake backs off', () => {
  expect(tunnelRetryWait({ opened: false, code: 0, reason: '' }, 1, '429 TUNNEL_LIMITED')).toBe(30_000)
})
