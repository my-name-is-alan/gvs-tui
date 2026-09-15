/**
 * Episode grid metrics. Pure math, shared by the picker that renders the cells
 * and by the shell that reports `1-84/240` in the header, so the two can never
 * disagree about what is on screen.
 */
export type GridWindow = {
  /** Cell width in cells, including the gap after it. */
  cellWidth: number
  /** Episode number column width. */
  numWidth: number
  /** Cells per row. */
  perRow: number
  /** Total rows the whole episode list needs. */
  totalRows: number
  /** First visible row. */
  startRow: number
  /** 1-based index of the first visible episode. */
  first: number
  /** 1-based index of the last visible episode (inclusive). */
  last: number
}

export function gridWindow(count: number, cursor: number, width: number, rows: number): GridWindow {
  const safeCount = Math.max(0, count)
  const numWidth = Math.max(2, String(safeCount).length)
  const cellWidth = numWidth + 4
  const perRow = Math.max(1, Math.floor(Math.max(1, width) / cellWidth))
  const totalRows = Math.ceil(safeCount / perRow)
  const visible = Math.max(1, Math.min(rows, totalRows || 1))
  const cursorRow = Math.floor(Math.max(0, Math.min(cursor, Math.max(0, safeCount - 1))) / perRow)
  const maxStart = Math.max(0, totalRows - visible)
  const startRow = totalRows <= visible ? 0 : Math.max(0, Math.min(cursorRow - Math.floor(visible / 2), maxStart))
  const first = Math.min(safeCount, startRow * perRow + 1)
  const last = Math.min(safeCount, (startRow + visible) * perRow)
  return { cellWidth, numWidth, perRow, totalRows, startRow, first, last }
}
