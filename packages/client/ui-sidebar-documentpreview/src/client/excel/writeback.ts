/**
 * Apply an edited grid back to the workbook it came from.
 *
 * The FILE owns everything the grid does not show: styles, merges, column widths,
 * the sheets the reader never opened. So this loads the original bytes and patches
 * the cells that changed, instead of serializing the grid from scratch and losing
 * all of it.
 *
 * Two rules keep the patch honest. A cell the grid showed before and no longer
 * holds is cleared, so deleting a value in the grid deletes it in the file. And
 * the caller only offers editing at all when the preview reported no unsupported
 * features, because the library that reads and writes the file drops what it does
 * not model — a workbook with charts must not be saved through it.
 */
import ExcelJS from 'exceljs'
import type { Cell, Sheet } from '@fortune-sheet/core'

/** The file's bytes as the library takes them: one ArrayBuffer, no views. */
function asArrayBuffer(bytes: Uint8Array<ArrayBuffer>): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

/** The grid's `=FORMULA` text as the file wants it, without the leading sign. */
function formulaOf(text: string): string {
  return text.startsWith('=') ? text.slice(1) : text
}

/** One sheet's cells by `row:column`, the way `celldata` addresses them. */
function cellsOf(sheet: Sheet | undefined): Map<string, Cell> {
  const cells = new Map<string, Cell>()
  for (const entry of sheet?.celldata ?? []) {
    // An address with no cell is how the grid records a cleared one.
    if (entry.v === null || entry.v === undefined) continue
    cells.set(`${entry.r}:${entry.c}`, entry.v)
  }
  return cells
}

/** The value the file should hold for one grid cell, or `null` when it holds none. */
function valueOf(cell: Cell): ExcelJS.CellValue {
  const value = cell.v
  return value === undefined || value === null ? null : value
}

/**
 * The cached result a formula value carries, in the narrow shape it accepts.
 * The grid's own cell values are text, numbers, and booleans; anything else is
 * left out rather than guessed at, so the file keeps its formula and no invented
 * cache travels with it.
 */
function cachedResultOf(cell: Cell): string | number | boolean | undefined {
  const value = cell.v
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : undefined
}

/** One field, quoted only when it must be to survive a round trip. */
function quoteField(field: string, delimiter: string): string {
  const mustQuote = field.includes(delimiter) || field.includes('"') || field.includes('\n') || field.includes('\r')
  return mustQuote ? `"${field.replace(/"/gu, '""')}"` : field
}

/** One cell as the file should hold it: a formula stays a formula, and a blank stays blank. */
function textOf(cell: Cell): string {
  const value = cell.v
  return value === undefined || value === null ? '' : String(value)
}

/**
 * Write the grid back to delimited text.
 *
 * A CSV holds one grid and nothing else — no styles, no merges, no second sheet — so unlike
 * a workbook there is nothing to patch: the file IS the grid, and every cell the reader sees
 * is a cell the file should hold. Quoting is the part that has to be right, because it is
 * the only thing standing between an edited field and a file that no longer parses: a field
 * is quoted when it contains the delimiter, a quote, or a line break, and its own quotes are
 * doubled, which is what the parser on the other side already assumes.
 * @param sheets - the grid as the reader left it; the first sheet is the file.
 * @param delimiter - `,` for csv, a tab for tsv.
 * @returns the file's bytes, UTF-8.
 */
export function serializeDelimited(sheets: readonly Sheet[], delimiter: string): Uint8Array<ArrayBuffer> {
  const cells = cellsOf(sheets[0])
  if (cells.size === 0) return new TextEncoder().encode('')
  let rows = 0
  let columns = 0
  for (const key of cells.keys()) {
    const [row, column] = key.split(':').map(Number)
    rows = Math.max(rows, (row ?? 0) + 1)
    columns = Math.max(columns, (column ?? 0) + 1)
  }
  const lines: string[] = []
  for (let row = 0; row < rows; row += 1) {
    const fields: string[] = []
    for (let column = 0; column < columns; column += 1) {
      const cell = cells.get(`${String(row)}:${String(column)}`)
      fields.push(quoteField(cell === undefined ? '' : textOf(cell), delimiter))
    }
    lines.push(fields.join(delimiter))
  }
  // A text file ends with a line break, and so does this one.
  return new TextEncoder().encode(`${lines.join('\n')}\n`)
}

/**
 * Write the grid's cells into the workbook's own bytes.
 * @param original - the file as it was read.
 * @param before - the grid the file produced, before the reader touched it.
 * @param after - the grid as the reader left it.
 * @returns the workbook's bytes with exactly those cells applied.
 */
export async function applyEdits(
  original: Uint8Array<ArrayBuffer>,
  before: readonly Sheet[],
  after: readonly Sheet[],
): Promise<Uint8Array<ArrayBuffer>> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(asArrayBuffer(original))
  for (const [index, sheet] of after.entries()) {
    // Position, not name: the grid and the file list their sheets in one order,
    // and a renamed sheet in the grid is still the same sheet in the file.
    const worksheet = workbook.worksheets[index]
    if (worksheet === undefined) continue
    const edited = cellsOf(sheet)
    for (const [key, cell] of edited) {
      const [row, column] = key.split(':').map(Number)
      const target = worksheet.getCell((row ?? 0) + 1, (column ?? 0) + 1)
      const formula = cell.f
      if (formula !== undefined && formula !== '') {
        // The cached result travels with the formula so a reader that does not
        // recalculate still shows the value the grid showed. Omitted, not
        // `undefined`: an absent result is not the same key as an empty one.
        const result = cachedResultOf(cell)
        target.value = result === undefined
          ? { formula: formulaOf(formula) }
          : { formula: formulaOf(formula), result }
      } else {
        target.value = valueOf(cell)
      }
    }
    for (const key of cellsOf(before[index]).keys()) {
      if (edited.has(key)) continue
      const [row, column] = key.split(':').map(Number)
      worksheet.getCell((row ?? 0) + 1, (column ?? 0) + 1).value = null
    }
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}
