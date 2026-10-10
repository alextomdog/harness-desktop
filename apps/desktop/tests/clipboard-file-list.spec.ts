/**
 * The shell's file-list format.
 *
 * This is the half of the clipboard read that needs no window: the read itself needs Electron, and
 * the parse is where the mistakes live, so they are pinned here.
 */
import { describe, expect, it } from 'vitest'
import { parseClipboardFileList } from '../src/clipboard-file-list.ts'

describe('the clipboard file list', () => {
  it('reads one path out of the list the shell writes', () => {
    expect(parseClipboardFileList('C:\\work\\a.py\u0000\u0000')).toEqual(['C:\\work\\a.py'])
  })

  it('reads several paths in the order the shell wrote them', () => {
    expect(parseClipboardFileList('C:\\work\\a.py\u0000C:\\work\\b.py\u0000\u0000'))
      .toEqual(['C:\\work\\a.py', 'C:\\work\\b.py'])
  })

  it('leaves nothing behind for a paste that names no file', () => {
    // A clipboard holding text or an image: nothing is the honest answer, and an empty string
    // masquerading as a path would have the caller try to copy a file that does not exist.
    expect(parseClipboardFileList('')).toEqual([])
    expect(parseClipboardFileList('\u0000\u0000')).toEqual([])
  })
})
