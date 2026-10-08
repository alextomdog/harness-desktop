// @vitest-environment jsdom
/**
 * What a document opens as.
 *
 * There is no edit mode. A file that can be edited opens in its editor — the highlighted,
 * line-numbered surface the read-only view used to be — and the caret is already in it.
 * The only thing that shows a rendered view instead is CHOOSING another implementation,
 * which is what the viewer menu writes and what these cases do.
 *
 * The editor writes the whole file back, so opening it reads the whole file: the pages
 * the reader would otherwise fetch on demand are fetched for it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { TextPreview } from '../src/client/TextPreview.tsx'
import { PLAIN_BODY_ID } from '../src/client/text/index.ts'
import { TAB_ID, harness, page, settle } from './fixtures.client.ts'

afterEach(cleanup)

/** Two pages, so that reading ahead has something to read. */
const twoPages = { 1: page(1, ['first', 'second'], false), 3: page(3, ['third'], true) }

describe('what a document opens as', () => {
  it('opens a file that can be edited in its editor, reading the whole file for it', async () => {
    const h = harness(twoPages, TAB_ID, { mode: 'document' })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    expect(view.container.querySelector('[data-textpreview-editor]')).not.toBeNull()
    expect(view.container.querySelector('[data-textpreview-textarea]')).not.toBeNull()
    // The source is painted with the read-only view's highlighter, beside line numbers.
    expect(view.container.querySelector('[data-textpreview-highlight]')).not.toBeNull()
    expect(view.container.querySelectorAll('[data-textpreview-line-number]')).toHaveLength(3)
    // No toggle stands between the reader and the text.
    expect(view.container.querySelector('[data-textpreview-tool="edit"]')).toBeNull()
    // Page 1, then the page after the lines that arrived: the editor holds the whole file.
    expect(h.read.mock.calls.map(([_session, _path, offset]) => offset)).toEqual([1, 3])
  })

  it('shows the implementation a reader chooses instead of the editor', async () => {
    const h = harness(twoPages, TAB_ID, { mode: 'document' })
    h.instance.actions.selected(TAB_ID, PLAIN_BODY_ID)
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    expect(view.container.querySelector('[data-textpreview-editor]')).toBeNull()
    expect(view.container.querySelectorAll('[data-textpreview-line]').length).toBeGreaterThan(0)
  })

  it('marks the line the caret is on, and moves the mark with it', async () => {
    const h = harness(twoPages, TAB_ID, { mode: 'document' })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    // The editor appears once the whole file is in hand, which is a read, not a render.
    const area = await waitFor(() => {
      const found = view.container.querySelector<HTMLTextAreaElement>('[data-textpreview-textarea]')
      expect(found).not.toBeNull()
      return found as HTMLTextAreaElement
    })
    await act(async () => { fireEvent.select(area) })
    // One mark, and it is the first line's, because the caret starts at the top.
    expect(view.container.querySelectorAll('[data-textpreview-active-line]')).toHaveLength(1)
    expect(view.container.querySelector('[data-textpreview-active-line-number]')?.textContent).toBe('1')
    // The caret moves without a keystroke, and the mark follows it rather than staying put.
    const field = area as HTMLTextAreaElement
    field.setSelectionRange(field.value.length, field.value.length)
    await act(async () => { fireEvent.select(field) })
    expect(view.container.querySelectorAll('[data-textpreview-active-line]')).toHaveLength(1)
    expect(view.container.querySelector('[data-textpreview-active-line-number]')?.textContent).toBe('3')
  })
})
