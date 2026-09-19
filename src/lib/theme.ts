// Single source of truth for the GVS terminal look: one cool neutral ramp, one
// accent, and three semantic tones. Nothing outside this file names a color, so
// the palette can be re-tuned in one place.

export const c = {
  /** Screen background. */
  bg: '#101715',
  /** Bars and cards that sit above the background. */
  panel: '#18221e',
  /** Recessed surfaces (inputs). */
  sunken: '#121b17',
  /** Hairlines and box borders. */
  line: '#30463c',
  /** Text hierarchies, brightest first. */
  text: '#e8eee9',
  dim: '#a2b2a8',
  faint: '#748a7d',
  /** The one accent color. Cursor, focus, brand, progress. */
  accent: '#6fd6af',
  /** Selected row background — a lifted slate, not a saturated block. */
  sel: '#243e32',
  /** Semantic tones. Only for state, never for decoration. */
  ok: '#34d399',
  warn: '#fbbf24',
  err: '#f87171',
  /** Reserved for metadata chips (DRM/codec), used sparingly. */
  violet: '#a2b2a8',
} as const

export type Tone = 'info' | 'ok' | 'warn' | 'err'

export function toneColor(tone: Tone): string {
  if (tone === 'ok') return c.ok
  if (tone === 'warn') return c.warn
  if (tone === 'err') return c.err
  return c.accent
}

export function toneIcon(tone: Tone): string {
  if (tone === 'ok') return '✔'
  if (tone === 'warn') return '!'
  if (tone === 'err') return '✖'
  return '·'
}

const PROVIDER_NAMES: Record<string, string> = {
  hongguo: '红果',
  youku: '优酷',
  tencent: '腾讯',
  douyin: '抖音',
}

export function providerName(id: string): string {
  return PROVIDER_NAMES[id] ?? id
}

/**
 * Settings values carry their own state in prose (`已连接`, `未配置`, `断开 …`),
 * so the color has to be read back out of the string.
 */
export function valueColor(value: string): string {
  if (!value || value === '未配置' || value === '未连接' || value === '未设' || value === '空') return c.faint
  if (/失败|错误|断开|没有|无效|不可用/.test(value)) return c.err
  if (/^(已|开$)|已连接|已保存|已登录|已配置|已导入/.test(value)) return c.ok
  return c.dim
}

export function jobTone(status: string): { icon: string; color: string } {
  if (status === '完成') return { icon: '✔', color: c.ok }
  if (status === '失败') return { icon: '✖', color: c.err }
  if (status === '排队') return { icon: '○', color: c.faint }
  if (/解密|合并|封装|校验/.test(status)) return { icon: '▸', color: c.accent }
  if (status === '下载' || status.startsWith('音轨')) return { icon: '↓', color: c.accent }
  return { icon: '·', color: c.warn }
}

/** Short, human label for a gateway host: `http://127.0.0.1:8080` → `127.0.0.1:8080`. */
export function hostLabel(host: string): string {
  return host.replace(/^https?:\/\//, '').replace(/\/+$/, '') || '未配置网关'
}
