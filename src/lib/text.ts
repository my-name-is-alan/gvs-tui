// Terminal text measured in cells, not code units. Chinese titles are 2 cells
// per glyph, so `String.length` padding produces ragged columns; every layout
// decision in the UI goes through these helpers instead.

const WIDE: Array<[number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
]

/** Zero-width code points: combining marks, and the invisible formatting range. */
const ZERO: Array<[number, number]> = [
  [0x0300, 0x036f], [0x200b, 0x200f], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
]

function inRanges(cp: number, ranges: Array<[number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (cp >= lo && cp <= hi) return true
  }
  return false
}

export function charWidth(cp: number): number {
  if (cp < 32 || cp === 0x7f) return 0
  if (inRanges(cp, ZERO)) return 0
  if (cp < 0x1100) return 1
  return inRanges(cp, WIDE) ? 2 : 1
}

/** Rendered width of `text` in terminal cells. */
export function displayWidth(text: string): number {
  let w = 0
  for (const ch of text) w += charWidth(ch.codePointAt(0) ?? 0)
  return w
}

/** Cut to at most `max` cells, with a single-cell ellipsis when anything was cut. */
export function clip(text: string, max: number): string {
  if (max <= 0) return ''
  if (displayWidth(text) <= max) return text
  let out = ''
  let w = 0
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0) ?? 0)
    if (w + cw > max - 1) break
    out += ch
    w += cw
  }
  return `${out}…`
}

export function padEnd(text: string, cells: number): string {
  const gap = cells - displayWidth(text)
  return gap > 0 ? text + ' '.repeat(gap) : text
}

export function padStart(text: string, cells: number): string {
  const gap = cells - displayWidth(text)
  return gap > 0 ? ' '.repeat(gap) + text : text
}

/** Pad text into an exact-width column, clipping it first when it does not fit. */
export function column(text: string, cells: number, align: 'left' | 'right' = 'left'): string {
  const fitted = displayWidth(text) > cells ? clip(text, cells) : text
  const pad = Math.max(0, cells - displayWidth(fitted))
  return align === 'right' ? ' '.repeat(pad) + fitted : fitted + ' '.repeat(pad)
}

/** Join columns, dropping any that would not fit rather than wrapping the line. */
export function joinColumns(cells: number, ...cols: Array<string | null | undefined | false>): string {
  const out: string[] = []
  let used = 0
  for (const col of cols) {
    if (!col) continue
    const w = displayWidth(col)
    if (used + w > cells) break
    out.push(col)
    used += w
  }
  return out.join('')
}

/** Repeated `─` rule that fills `cells` columns. */
export function rule(cells: number): string {
  return '─'.repeat(Math.max(0, cells))
}

/** Wrap long logs without splitting Chinese glyphs or hiding their tail. */
export function wrapLines(text:string,width:number):string[]{
 const lines:string[]=[]
 for(const source of text.split('\n')){
  let line='',used=0
  for(const ch of source){const n=charWidth(ch.codePointAt(0)??0);if(used+n>Math.max(2,width)){lines.push(line);line='';used=0}line+=ch;used+=n}
  lines.push(line)
 }
 return lines
}
