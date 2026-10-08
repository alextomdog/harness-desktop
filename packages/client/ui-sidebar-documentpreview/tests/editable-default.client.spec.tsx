// @vitest-environment jsdom
/**
 * What a document opens as.
 *
 * The reader used to be the default, and editing a mode the reader switched on. A file
 * that can be edited should not need to be asked twice 鈥?but editing also holds the
 * whole file, while paging exists so that a large one never has to be. So the default
 * follows two things the document already states about itself: whether its renderer
 * can be edited, and the size its metadata reports.
 *
 * The store keeps the reader's own wish per tab, and these cases assert the default
 * that applies when no wish has been recorded.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { TextPreview } from '../src/client/TextPreview.tsx'
import { TAB_ID, harness, page, settle } from './fixtures.client.ts'

afterEach(cleanup)

/** Two pages, so that reading ahead has something to read. */
const twoPages = { 1: page(1, ['first', 'second'], false), 3: page(3, ['third'], true) }

describe('what a document opens as', () => {
  it('opens a small editable file in its editor, reading the whole file for it', async () => {
    const h = harness(twoPages, TAB_ID, { mode: 'document' })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    expect(view.container.querySelector('[data-textpreview-editor]')).not.toBeNull()
    // The editor writes the whole file back, so it reads the rest of it: page 1, then
    // the page after the lines that arrived.
    expect(h.read.mock.calls.map(([_session, _path, offset]) => offset)).toEqual([1, 3])
  })

  it('opens a large editable file in its reader, with the editor one press away', async () => {
    const h = harness(twoPages, TAB_ID, { mode: 'document', bytes: 2 * 1024 * 1024 })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    expect(view.container.querySelector('[data-textpreview-editor]')).toBeNull()
    expect(view.container.querySelectorAll('[data-textpreview-line]')).toHaveLength(2)
    // Reading is what it opens as, so only the first page was read.
    expect(h.read.mock.calls.map(([_session, _path, offset]) => offset)).toEqual([1])
    // And the offer is there: pressing it is what reads the rest.
    fireEvent.click(view.container.querySelector('[data-textpreview-tool="edit"]')!)
    await settle()
    expect(view.container.querySelector('[data-textpreview-editor]')).not.toBeNull()
    expect(h.read.mock.calls.map(([_session, _path, offset]) => offset)).toEqual([1, 3])
  })
})
