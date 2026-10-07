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
 * A structure the grid holds — rich text, an error object — is left out rather
 * than guessed at: the file keeps its formula, and no invented cache travels
 * with it.
 */
function cachedResultOf(cell: Cell): string | number | boolean | Date | undefined {
  const value = cell.v
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return value instanceof Date ? value : undefined
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
