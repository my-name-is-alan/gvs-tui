import { test, expect } from 'bun:test'
import { tencentNeedsRelogin, txAccountSummary, type TxAccount } from './tencent-account.ts'

test('txAccountSummary prefers TV/App nick and vip lines', () => {
  expect(txAccountSummary(null)).toContain('未登录')
  const acc: TxAccount = {
    loggedIn: true,
    nick: '小明',
    app: { loggedIn: true, nick: 'App君', vipSummary: '', isVip: false, expiry: 'unknown' },
    tv: { loggedIn: true, nick: 'TV君', vipSummary: '影视VIP · 至 2027', isVip: true, expiry: 'unknown' },
    cookie: { loggedIn: false, nick: '', vipSummary: '', isVip: false, expiry: 'unknown' },
    summary: '',
  }
  const line = txAccountSummary(acc)
  expect(line).toContain('TV')
  expect(line).toContain('TV君')
  expect(line).toContain('App')
})

test('expired login is labeled and asks for a new scan', () => {
  const acc: TxAccount = {
    loggedIn: true,
    nick: 'TV君',
    app: { loggedIn: false, nick: '', vipSummary: '', isVip: false, expiry: 'unknown' },
    tv: { loggedIn: true, nick: 'TV君', vipSummary: '', isVip: true, expiry: 'expired' },
    cookie: { loggedIn: false, nick: '', vipSummary: '', isVip: false, expiry: 'unknown' },
    summary: '',
  }
  expect(txAccountSummary(acc)).toContain('TV已过期')
  expect(tencentNeedsRelogin(acc)).toBe(true)
})
