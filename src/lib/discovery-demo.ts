import { demoSnapshot } from './demo'
import { fallbackSections } from './discovery'
export async function demoInvoke(
  provider: string,
  action: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await new Promise((resolve) => setTimeout(resolve, 40))
  if (action === 'browse_catalog')
    return {
      sections: fallbackSections(provider).map((s) => ({
        ...s,
        id: s.id.replace('legacy-', ''),
        available: s.mode === 'home' || provider !== 'youku',
        reason:
          s.mode === 'rank' && provider === 'youku'
            ? '演示：独立榜单不可用'
            : s.reason,
        filters:
          provider === 'hongguo'
            ? [
                {
                  key: 'genre',
                  title: '体裁',
                  options: [
                    { value: 'all', label: '全部' },
                    { value: 'human', label: '真人' },
                    { value: 'comic', label: '漫剧' },
                  ],
                },
              ]
            : [],
      })),
    }
  if (action === 'browse' || action === 'search') {
    const offset = Number(input.cursor || 0),
      count = provider === 'hongguo' ? 12 : 8
    const items = Array.from({ length: count }, (_, i) => ({
      id: `demo-${provider}-${offset + i}`,
      title: `${['长安夜雨', '山海来信', '春日来客', '寻味四季'][i % 4]} ${offset + i + 1}`,
      subtitle: '演示内容 · 正片 · 请勿当作真实榜单',
      rank: input.mode === 'rank' ? offset + i + 1 : undefined,
      target:
        provider === 'tencent' && action === 'browse'
          ? { type: 'search', query: '长安夜雨' }
          : { type: 'detail', id: `demo-${provider}-${offset + i}` },
    }))
    return {
      items,
      hasMore: provider === 'hongguo' && offset < 24,
      nextCursor:
        provider === 'hongguo' && offset < 24 ? String(offset + 12) : '',
      contentType: input.mode === 'rank' ? 'rank' : 'recommendation',
      source: '离线演示',
      category: input.mode === 'rank' ? '公开榜单' : '平台推荐',
    }
  }
  if (action === 'detail') {
    const d = demoSnapshot('detail', 0)
    return {
      title: '长安夜雨（演示）',
      episodes: d.episodes,
      desc: d.detail?.desc,
      category: '电视剧',
      episode_count: d.episodes?.length,
    }
  }
  return {}
}
