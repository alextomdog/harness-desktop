// @vitest-environment jsdom
/**
 * The close question the dock's refusal puts on screen.
 *
 * These cases all answer it WITHOUT saving, so the save port is a promise that never settles:
 * what is being pinned down here is the question itself — that it appears only when the dock
 * refused, that discarding gives the edits up and asks for the tab, and that cancelling leaves
 * everything exactly where it was.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { EditableTextBody } from '../src/client/editable/EditableTextBody.tsx'

/** The editor's own copy, complete because the type is. */
const LABELS = {
  saving: 'Saving…',
  saved: 'Saved',
  stale: 'The file changed',
  keepMine: 'Keep mine',
  useDisk: 'Use the file',
  failed: 'Save failed',
  editAria: 'File contents',
  saveHint: 'Ctrl + S to save',
} as const

const CLOSE_LABELS = {
  message: 'This tab has unsaved changes',
  save: 'Save and close',
  discard: 'Close without saving',
  cancel: 'Cancel',
} as const

/** A save that never settles: nothing here is about writing the file. */
const neverSaves = (): Promise<never> => new Promise<never>(() => undefined)

/**
 * Render the editor with the dock's refusal in hand.
 * @returns the container and the port the question answers through.
 */
function editor(closePrompt: boolean) {
  const onDirty = vi.fn()
  const onResolveClose = vi.fn()
  const onRequestClose = vi.fn()
  const view = render(
    <EditableTextBody
      text={'first line\nsecond line'}
      version="v1"
      save={neverSaves}
      reload={() => undefined}
      onDirty={onDirty}
      labels={LABELS}
      {...closePrompt ? { closePrompt: true, closeLabels: CLOSE_LABELS } : {}}
      onResolveClose={onResolveClose}
      onRequestClose={onRequestClose}
    />,
  )
  return { view, onDirty, onResolveClose, onRequestClose }
}

describe('the unsaved-edits close question', () => {
  afterEach(() => { cleanup() })

  it('appears when the dock refused the close, and offers the three answers', () => {
    const h = editor(true)
    const bar = h.view.container.querySelector('[data-textpreview-close-prompt]')
    expect(bar).not.toBeNull()
    expect(bar?.textContent).toContain(CLOSE_LABELS.message)
    expect(h.view.container.querySelector('[data-textpreview-close-save]')).not.toBeNull()
    expect(h.view.container.querySelector('[data-textpreview-close-discard]')).not.toBeNull()
    expect(h.view.container.querySelector('[data-textpreview-close-cancel]')).not.toBeNull()
  })

  it('is absent while no close was refused', () => {
    const h = editor(false)
    expect(h.view.container.querySelector('[data-textpreview-close-prompt]')).toBeNull()
  })

  it('gives the edits up and asks for the tab when the reader discards them', () => {
    const h = editor(true)
    // The reader has typed, so the tab really is dirty.
    const area = h.view.container.querySelector<HTMLTextAreaElement>('[data-textpreview-textarea]')
    expect(area).not.toBeNull()
    fireEvent.change(area as HTMLTextAreaElement, { target: { value: 'edited' } })

    fireEvent.click(h.view.container.querySelector('[data-textpreview-close-discard]') as HTMLElement)

    // Dirty clears because the reader said so, and the tab goes because there is nothing
    // left in it worth keeping.
    expect(h.onDirty).toHaveBeenCalledWith(false)
    expect(h.onResolveClose).toHaveBeenCalledWith('discard')
  })

  it('leaves the edits alone when the reader cancels', () => {
    const h = editor(true)
    const area = h.view.container.querySelector<HTMLTextAreaElement>('[data-textpreview-textarea]')
    fireEvent.change(area as HTMLTextAreaElement, { target: { value: 'edited' } })
    h.onDirty.mockClear()

    fireEvent.click(h.view.container.querySelector('[data-textpreview-close-cancel]') as HTMLElement)

    expect(h.onResolveClose).toHaveBeenCalledWith('cancel')
    // Cancelling says nothing about the work, so nothing about the work is touched.
    expect(h.onDirty).not.toHaveBeenCalled()
  })
})
