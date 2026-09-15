// Check that naming uses the standard tier, not the raw pixel height.
import { filename, tierHeight, type Naming } from '../src/lib/name.ts'

const cases: Array<[number, number, string]> = [
  [3840, 1920, '2160p'],   // 4K 2:1 画幅（就是出现 1920p 的那条）
  [3840, 1608, '2160p'],   // 4K 宽银幕
  [3840, 2160, '2160p'],
  [1920, 1080, '1080p'],
  [1920, 808, '1080p'],    // 1080p 宽银幕
  [1280, 536, '720p'],
  [864, 362, '480p'],
  [640, 268, '360p'],
  [0, 1920, '2160p'],      // 只给高度时的兜底
  [0, 1080, '1080p'],
]

let bad = 0
for (const [w, h, want] of cases) {
  const tier = tierHeight(w, h)
  const base: Naming = {
    kind: 'show', title: '边水往事', nameDots: '边水往事', year: 2024, season: 1, episode: 21,
    height: tier, codec: 'H265', source: 'YK', group: 'FKNest', tmdbId: 0, container: 'mkv',
  }
  const name = filename(base)
  const ok = tier === Number.parseInt(want, 10) && name.includes(`.${want}.`)
  if (!ok) bad++
  console.log(`${ok ? '✓' : '✗'} ${String(w).padStart(4)}×${String(h).padEnd(4)} → ${String(tier).padStart(4)}p  ${name}`)
}
console.log(bad ? `${bad} 个档位不对` : '全部按规范档位命名')
process.exit(bad ? 1 : 0)
