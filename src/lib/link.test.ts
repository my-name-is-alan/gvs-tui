import { expect, test } from 'bun:test'
import { extractYoukuVideoId, extractTencentLinks, parseTencentURL } from './link.ts'

test.each([
  ['https://v.youku.com/v_show/id_XNjEyMzQ1==.html?spm=abc', 'XNjEyMzQ1=='],
  ['分享：https://v.youku.com/v_show/id_XNjEyMzQ1.html。', 'XNjEyMzQ1'],
  ['v.youku.com/v_show/id_XNjEyMzQ1.html', 'XNjEyMzQ1'],
  ['https://m.youku.com/video?vid=XNjEyMzQ1%3D%3D', 'XNjEyMzQ1=='],
  ['https://m.youku.com/video?videoId=XNjEyMzQ1', 'XNjEyMzQ1'],
  ['https://evil.youku.com.evil.org/v_show/id_X123.html', ''],
  ['https://evil.org/?vid=X123', ''],
  ['https://list.youku.com/show/id_abc.html', ''],
  ['https://v.youku.com/v_show/id_%ZZ.html', ''],
  ['普通搜索标题', ''],
])('Youku video link %s', (input, vid) => {
  expect(extractYoukuVideoId(input)).toBe(vid)
})

test.each([
  ['https://v.qq.com/x/cover/mzc00200b4jsdq6/l00469csvi7.html', 'l00469csvi7', 'mzc00200b4jsdq6'],
  ['https://m.v.qq.com/play.html?cid=mzc00200b4jsdq6&vid=l00469csvi7', 'l00469csvi7', 'mzc00200b4jsdq6'],
  ['https://v.qq.com/x/page/x4100q9dcge.html', 'x4100q9dcge', ''],
  ['https://v.qq.com/x/cover/mzc00200b4jsdq6.html', '', 'mzc00200b4jsdq6'],
  ['https://film.qq.com/video/mzc00200b4jsdq6.html', '', 'mzc00200b4jsdq6'],
  ['https://evil.org/?vid=l00469csvi7', '', ''],
])('Tencent HTML link %s', (input, vid, cid) => {
  const got = parseTencentURL(input)
  expect(got.vid).toBe(vid)
  expect(got.cid).toBe(cid)
})

test('extracts up to two Tencent page URLs from pasted text', () => {
  const text =
    '看这两集 https://v.qq.com/x/page/x4100q9dcge.html 还有 https://m.v.qq.com/play.html?vid=l00469csvi7&cid=mzc00200b4jsdq6'
  const got = extractTencentLinks(text)
  expect(got).toHaveLength(2)
  expect(got[0]?.vid).toBe('x4100q9dcge')
  expect(got[1]?.vid).toBe('l00469csvi7')
})
