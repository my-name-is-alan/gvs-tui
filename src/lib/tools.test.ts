import { expect, test } from 'bun:test'
import { mkvLang } from './mkvmerge.ts'
import { m3u8dlRid, pickM3u8dlAsset, pickMkvmergeAsset, pickPackagerAsset } from './tools.ts'

const m3u8Names = [
  'N_m3u8DL-RE_v0.6.0-beta_android-bionic-x64_20260629.tar.gz',
  'N_m3u8DL-RE_v0.6.0-beta_linux-x64_20260629.tar.gz',
  'N_m3u8DL-RE_v0.6.0-beta_osx-arm64_20260629.tar.gz',
  'N_m3u8DL-RE_v0.6.0-beta_win-arm64_20260629.zip',
  'N_m3u8DL-RE_v0.6.0-beta_win-x64_20260629.zip',
]

test('m3u8dlRid windows x64', () => {
  expect(m3u8dlRid('win32', 'x64')).toBe('win-x64')
  expect(m3u8dlRid('win32', 'arm64')).toBe('win-arm64')
  expect(m3u8dlRid('linux', 'x64')).toBe('linux-x64')
  expect(m3u8dlRid('darwin', 'arm64')).toBe('osx-arm64')
})

test('pickM3u8dlAsset skips android and matches rid', () => {
  expect(pickM3u8dlAsset(m3u8Names, 'win-x64')).toBe('N_m3u8DL-RE_v0.6.0-beta_win-x64_20260629.zip')
  expect(pickM3u8dlAsset(m3u8Names, 'linux-x64')).toBe('N_m3u8DL-RE_v0.6.0-beta_linux-x64_20260629.tar.gz')
})

test('pickMkvmergeAsset prefers x64 zip', () => {
  const names = [
    'mkvtoolnix-i686-win.zip',
    'mkvtoolnix-x86_64-linux.tar.xz',
    'mkvtoolnix-x86_64-win.zip',
  ]
  expect(pickMkvmergeAsset(names, 'win32', 'x64')).toBe('mkvtoolnix-x86_64-win.zip')
  expect(pickMkvmergeAsset(names, 'linux', 'x64')).toBe('mkvtoolnix-x86_64-linux.tar.xz')
})

test('pickPackagerAsset maps platform to raw binary', () => {
  const names = [
    'packager-linux-arm64',
    'packager-linux-x64',
    'packager-osx-arm64',
    'packager-osx-x64',
    'packager-win-x64.exe',
  ]
  expect(pickPackagerAsset(names, 'win32', 'x64')).toBe('packager-win-x64.exe')
  expect(pickPackagerAsset(names, 'darwin', 'arm64')).toBe('packager-osx-arm64')
  expect(pickPackagerAsset(names, 'linux', 'x64')).toBe('packager-linux-x64')
})


test('mkvLang maps 优酷 labels to ISO 639-2', () => {
  expect(mkvLang('英语')).toBe('eng')
  expect(mkvLang('普通话')).toBe('chi')
  expect(mkvLang('chi')).toBe('chi')
  expect(mkvLang('jpn')).toBe('jpn')
  expect(mkvLang('')).toBe('und')
})
