import { expect, test } from 'bun:test'
import { extractYoukuVideoId } from './link.ts'

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
