// Single source of truth for the GVS terminal look: one cool neutral ramp, one
// accent, and three semantic tones. Nothing outside this file names a color, so
// the palette can be re-tuned in one place.

export const c = {
  /** Screen background. */
  bg: '#0b1017',
  /** Bars and cards that sit above the background. */
  panel: '#131b26',
  /** Recessed surfaces (inputs). */
  sunken: '#0e151f',
  /** Hairlines and box borders. */
  line: '#1e2a3a',
  /** Text hierarchies, brightest first. */
  text: '#e8eef6',
  dim: '#9aa8b8',
  faint: '#5f7086',
  /** The one accent color. Cursor, focus, brand, progress. */
  accent: '#7dd3fc',
  /** Selected row background — a lifted slate, not a saturated block. */
  sel: '#17293c',
  /** Semantic tones. Only for state, never for decoration. */
  ok: '#34d399',
  warn: '#fbbf24',
  err: '#f87171',
  /** Reserved for metadata chips (DRM/codec), used sparingly. */
  violet: '#a78bfa',
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
  switch (status) {
    case '完成': return { icon: '✔', color: c.ok }
    case '失败': return { icon: '✖', color: c.err }
    case '排队': return { icon: '○', color: c.faint }
    case '下载': return { icon: '↓', color: c.accent }
    case '解密':
    case '封装': return { icon: '▸', color: c.accent }
    default: return { icon: '·', color: c.warn }
  }
}

/** Short, human label for a gateway host: `http://127.0.0.1:8080` → `127.0.0.1:8080`. */
export function hostLabel(host: string): string {
  return host.replace(/^https?:\/\//, '').replace(/\/+$/, '') || '未配置网关'
}
