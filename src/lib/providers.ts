/** Shared, transport-free provider metadata for terminal and desktop clients. */
export const PROVIDER_IDS = ['youku', 'tencent', 'hongguo', 'huangguo', 'douyin', 'mewatch', 'hamivideo', 'iq', 'iqcn'] as const
export type ProviderID = (typeof PROVIDER_IDS)[number]
export const PROVIDER_LABELS: Record<string, string> = {
  youku: '优酷', tencent: '腾讯', hongguo: '红果', huangguo: '黄果', douyin: '抖音',
  mewatch: 'mewatch', hamivideo: 'HamiVideo',
  iq: 'IQ 海外版',
  iqcn: '爱奇艺国内版',
}
export const supportsSearch = (provider: string): boolean => provider !== 'hamivideo'
export const supportsBrowse = (provider: string): boolean => provider !== 'hamivideo'
export const isManifestProvider = (provider: string): boolean => provider === 'mewatch' || provider === 'hamivideo'
/** Providers with the shared movie/series type and optional TMDB naming workflow. */
export const supportsTmdb = (provider: string | undefined): boolean => provider === 'youku' || provider === 'tencent' || provider === 'iq' || provider === 'iqcn'
