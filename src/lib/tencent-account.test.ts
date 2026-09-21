import { test, expect } from 'bun:test'
import { txAccountSummary, type TxAccount } from './tencent-account.ts'

test('txAccountSummary prefers TV/App nick and vip lines', () => {
  expect(txAccountSummary(null)).toContain('未登录')
  const acc: TxAccount = {
    loggedIn: true,
    nick: '小明',
    app: { loggedIn: true, nick: 'App君', vipSummary: '', isVip: false },
    tv: { loggedIn: true, nick: 'TV君', vipSummary: '影视VIP · 至 2027', isVip: true },
    cookie: { loggedIn: false, nick: '', vipSummary: '', isVip: false },
    summary: '',
  }
  const line = txAccountSummary(acc)
  expect(line).toContain('TV')
  expect(line).toContain('TV君')
  expect(line).toContain('App')
})
