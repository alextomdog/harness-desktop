// @vitest-environment node
/**
 * The patch's two promises, which are the whole reason it loads the original
 * bytes instead of serializing the grid: a change lands in the file, and
 * everything the grid never showed — styles, merges, other sheets — survives.
 */
import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import type { Sheet } from '@fortune-sheet/core'
import { applyEdits } from '../src/client/excel/writeback.ts'

/** One grid cell as `celldata` addresses it. */
interface GridCell {
  readonly r: number
  readonly c: number
  readonly v: { readonly v?: string | number; readonly f?: string }
}

/** The grid shape a workbook previews as. Only the fields under test are filled. */
function grid(...cells: readonly GridCell[]): Sheet[] {
  return [{ name: 'Sheet1', celldata: cells } as unknown as Sheet]
}

/** A workbook with a value, a bold style, a merge, a formula, and a second sheet. */
async function workbookBytes(): Promise<Uint8Array<ArrayBuffer>> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Sheet1')
  sheet.getCell('A1').value = 'keep'
  sheet.getCell('A1').font = { bold: true }
  sheet.mergeCells('B1:C1')
  sheet.getCell('B1').value = 'merged'
  sheet.getCell('A2').value = 1
  sheet.getCell('A3').value = { formula: 'A2*2', result: 2 }
  workbook.addWorksheet('Sheet2').getCell('A1').value = 'untouched'
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

/** Read one written workbook back for assertions. */
async function reopen(bytes: Uint8Array<ArrayBuffer>): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes.buffer as ArrayBuffer)
  return workbook
}

describe('applyEdits', () => {
  it('applies the change, clears what the grid dropped, and preserves the rest of the file', async () => {
    const original = await workbookBytes()
    const before = grid(
      { r: 0, c: 0, v: { v: 'keep' } },
      { r: 0, c: 1, v: { v: 'merged' } },
      { r: 1, c: 0, v: { v: 1 } },
    )
    const after = grid(
      { r: 0, c: 0, v: { v: 'keep' } },
      // B1 is gone from the grid: the reader cleared it, so the file clears it.
      { r: 1, c: 0, v: { v: 42 } },
    )
    const reopened = await reopen(await applyEdits(original, before, after))
    const sheet = reopened.worksheets[0]
    expect(sheet?.getCell('A2').value).toBe(42)
    expect(sheet?.getCell('B1').value).toBeNull()
    // What the grid never showed is still there.
    expect(sheet?.getCell('A1').value).toBe('keep')
    expect(sheet?.getCell('A1').font?.bold).toBe(true)
    expect(sheet?.getCell('B1').isMerged).toBe(true)
    expect(reopened.worksheets[1]?.getCell('A1').value).toBe('untouched')
  })

  it('writes a formula the grid shows, with its cached result', async () => {
    const original = await workbookBytes()
    const before = grid({ r: 2, c: 0, v: { v: 2, f: '=A2*2' } })
    const after = grid({ r: 2, c: 0, v: { v: 84, f: '=A2*42' } })
    const reopened = await reopen(await applyEdits(original, before, after))
    const cell = reopened.worksheets[0]?.getCell('A3')
    expect(cell?.value).toEqual({ formula: 'A2*42', result: 84 })
  })

  it('leaves the file byte-identical when the grid did not change', async () => {
    const original = await workbookBytes()
    const same = grid({ r: 0, c: 0, v: { v: 'keep' } }, { r: 1, c: 0, v: { v: 1 } })
    const reopened = await reopen(await applyEdits(original, same, same))
    expect(reopened.worksheets[0]?.getCell('A1').value).toBe('keep')
    expect(reopened.worksheets[0]?.getCell('A1').font?.bold).toBe(true)
  })
})
