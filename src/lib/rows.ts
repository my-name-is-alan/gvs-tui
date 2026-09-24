// Row rendering. Every list in the app is one `<Text>` per line built by
// `colsLine`, which keeps rows exactly `width` cells wide — that is what makes
// columns line up, what makes the selected-row background span the full row,
// and what stops a long Chinese title from wrapping into the next line.
import { StyledText, bg, bold, fg } from 'vue-termui'
import type { TextChunk } from 'vue-termui'
import { c } from './theme.ts'
import { column, displayWidth } from './text.ts'

/** Two-cell cursor bar shown on the selected row. */
export const MARK = '▌ '

export type Col = {
  /** Plain text for the column. */
  text?: string
  /** Dynamic chunks (progress bars); requires `cells`. */
  chunks?: (cells: number) => TextChunk[]
  color?: string
  /** Fixed width in cells; omit with `grow` to absorb leftover space. */
  cells?: number
  align?: 'left' | 'right'
  bold?: boolean
  grow?: boolean
}

/**
 * Lay out one row of columns exactly `width` cells wide. Growing columns share
 * the leftover space, fixed columns are clipped/padded to their width.
 */
export function colsLine(cols: Col[], width: number, selected = false): StyledText {
  const fixed = cols.reduce((n, col) => n + (col.grow ? 0 : col.cells ?? displayWidth(col.text ?? '')), 0)
  const grow = cols.filter((col) => col.grow).length
  const share = grow ? Math.floor(Math.max(0, width - fixed) / grow) : 0
  const chunks: TextChunk[] = []
  let used = 0

  cols.forEach((col, index) => {
    const last = index === cols.length - 1
    const cells = col.grow ? (last ? Math.max(0, width - used) : share) : col.cells ?? displayWidth(col.text ?? '')
    used += cells
    if (cells <= 0) return
    if (col.chunks) {
      chunks.push(...col.chunks(cells))
      return
    }
    const text = column(col.text ?? '', cells, col.align === 'right' ? 'right' : 'left')
    // Build the chunk explicitly: chunks are merged by `applyStyle`, so bold
    // keeps the color that was set first.
    const chunk: TextChunk = col.color ? fg(col.color)(text) : { __isChunk: true, text }
    chunks.push(col.bold ?? selected ? bold(chunk) : chunk)
  })

  return new StyledText(chunks)
}

/** `████░░░░` — filled cells use the accent, the empty track stays quiet. */
export function barChunks(pct: number, cells: number, color = c.accent): TextChunk[] {
  const filled = Math.round(Math.max(0, Math.min(1, pct)) * cells)
  return [fg(color)('█'.repeat(filled)), fg(c.line)('░'.repeat(Math.max(0, cells - filled)))]
}

/** ` 红果 ` tab. The active one sits on the selection slate in the accent color. */
export function tabChunks(label: string, on: boolean, enabled = true): TextChunk[] {
  const text = ` ${label} `
  if (on) return [bg(c.sel)(fg(c.accent)(bold(text)))]
  return [fg(enabled ? c.dim : c.faint)(text)]
}

/** Cells taken by `tabChunks` for these labels. */
export function tabsWidth(labels: string[]): number {
  return labels.reduce((n, label) => n + displayWidth(label) + 2, 0)
}

/** Cursor column shared by every pickable list. */
export function markCol(selected: boolean, color = c.accent): Col {
  return { text: selected ? MARK : '  ', cells: 2, color: selected ? color : undefined, bold: false }
}

/**
 * A one-line styled string. `fg()` returns a chunk, but `<Text :content>` takes
 * a `StyledText`, so text set inline goes through here.
 */
export function ink(color: string, text: string, strong = false): StyledText {
  const chunk = fg(color)(text)
  return new StyledText([strong ? bold(chunk) : chunk])
}

/** `▌ 标题 …………………………… 红果 · 1234567` */
export function pickLine(label: string, meta: string, width: number, selected: boolean, labelColor?: string): StyledText {
  const cols: Col[] = [markCol(selected)]
  if (meta) {
    cols.push({ text: label, grow: true, color: labelColor ?? (selected ? c.text : c.dim), bold: selected })
    cols.push({ text: meta, cells: displayWidth(meta), align: 'right', color: c.faint })
  } else {
    cols.push({ text: label, grow: true, color: labelColor ?? (selected ? c.text : c.dim), bold: selected })
  }
  return colsLine(cols, width, selected)
}

/** `▌ 隧道            已连接 · 优酷/腾讯走本机 IP` */
export function kvLine(
  label: string,
  value: string,
  width: number,
  selected: boolean,
  valueColor = c.dim,
  labelCells = 16,
): StyledText {
  const cells = Math.min(labelCells, Math.max(8, Math.floor(width / 3)))
  return colsLine(
    [
      markCol(selected),
      { text: label, cells, color: selected ? c.text : c.dim, bold: selected },
      { text: value, grow: true, color: valueColor },
    ],
    width,
    selected,
  )
}

/** `▌ 粘贴链接      抖音分享口令 / 链接，直接解析` */
export function descLine(label: string, desc: string, width: number, selected: boolean, labelCells = 12): StyledText {
  return colsLine(
    [
      markCol(selected),
      { text: label, cells: labelCells, color: selected ? c.text : c.dim, bold: selected },
      { text: desc, grow: true, color: c.faint },
    ],
    width,
    selected,
  )
}
