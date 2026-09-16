import { describe, expect, test } from 'bun:test'
import { parseYkAccount, shouldRefreshYouku, type YkLogin } from './youku-session.ts'

const baseLogin: YkLogin = {
  ok: true,
  uid: '1',
  nick: 'tester',
  vip: false,
  refreshable: true,
  createdAt: 0,
  lastRefreshAt: 0,
  lastError: '',
  hint: '',
}

describe('shouldRefreshYouku', () => {
  const now = Date.UTC(2026, 8, 16, 12, 0, 0)

  test('refreshes a mature credential that has never been refreshed', () => {
    expect(shouldRefreshYouku({ ...baseLogin, createdAt: now - 2 * 60_000 }, now)).toBe(true)
  })

  test('does not refresh immediately after QR completion', () => {
    expect(shouldRefreshYouku({ ...baseLogin, createdAt: now - 30_000 }, now)).toBe(false)
  })

  test('refreshes after twenty minutes and skips non-refreshable credentials', () => {
    expect(shouldRefreshYouku({ ...baseLogin, lastRefreshAt: now - 21 * 60_000 }, now)).toBe(true)
    expect(shouldRefreshYouku({ ...baseLogin, refreshable: false, createdAt: now - 60 * 60_000 }, now)).toBe(false)
  })
})

describe('parseYkAccount', () => {
  test('accepts normal MTOP SUCCESS responses and reads membership expiry', () => {
    const acc = parseYkAccount({
      session: { logged_in: true, method: 'web-cookie', nick: 'Alice', uid: '42' },
      risk: { level: 'none' },
      summary: { logged_in: true, is_vip: false },
      profile: {
        member_profile_get: {
          ret: ['SUCCESS::调用成功'],
          data: { memberInfo: { isVip: 1, endTime: '1893456000000' } },
        },
      },
    })

    expect(acc.loggedIn).toBe(true)
    expect(acc.method).toBe('web-cookie')
    expect(acc.vipSource).toBe('api')
    expect(acc.isVip).toBe(true)
    expect(acc.vipUntil).toBe('2030-01-01')
  })

  test('treats a successful profile with no active product as authoritative non-member', () => {
    const acc = parseYkAccount({
      session: { logged_in: true, method: 'web-cookie' },
      summary: { logged_in: true },
      profile: { member_profile_get: { ret: ['SUCCESS::调用成功'], data: {} } },
    })

    expect(acc.vipSource).toBe('api')
    expect(acc.isVip).toBe(false)
  })

  test('prefers the gateway standardized membership summary', () => {
    const acc = parseYkAccount({
      session: { logged_in: true, method: 'web-cookie' },
      summary: {
        logged_in: true,
        membership_known: true,
        membership_status: 'active',
        is_vip: true,
        expire_at: '2031-06-30T00:00:00Z',
      },
    })

    expect(acc.vipSource).toBe('api')
    expect(acc.isVip).toBe(true)
    expect(acc.vipUntil).toBe('2031-06-30')
  })

  test('does not mistake SESSION_EXPIRED for a logged-out app session', () => {
    const acc = parseYkAccount({
      session: { logged_in: true, method: 'qr', yktk_vip: false },
      summary: { logged_in: true },
      profile: {
        member_profile_get: { ret: ['FAIL_SYS_SESSION_EXPIRED::Session过期'], data: {} },
      },
    })

    expect(acc.loggedIn).toBe(true)
    expect(acc.needsScan).toBe(false)
    expect(acc.vipSource).toBe('none')
  })
})
