// @vitest-environment jsdom
/**
 * The editor's own contract, which is the editor's whole behaviour: typing marks
 * the tab dirty and writes NOTHING, Ctrl+S is what saves, and a refusal keeps the
 * reader's words on screen and asks which side wins instead of guessing.
 *
 * The last case protects the reader's work: a file written underneath them must
 * not replace what they are typing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EditableTextBody } from '../src/client/editable/EditableTextBody.tsx'
import type { EditableTextLabels } from '../src/client/editable/EditableTextBody.tsx'
import type { WriteWorkspaceFileOutcome } from '../src/client/rpc.ts'

const LABELS: EditableTextLabels = {
  saving: 'saving', saved: 'saved', stale: 'stale', keepMine: 'keep',
  useDisk: 'disk', failed: 'failed', editAria: 'contents', saveHint: 'Ctrl + S to save',
}

/** The textarea, read back as the reader sees it. */
function area(): HTMLTextAreaElement {
  return screen.getByLabelText('contents') as HTMLTextAreaElement
}

/** A save nothing in a case cares about, past the type. */
const ignore = async (): Promise<WriteWorkspaceFileOutcome> => ({ kind: 'saved', version: 'v1' })

afterEach(() => { cleanup() })

describe('EditableTextBody', () => {
  it('marks the tab dirty while typing, and writes nothing until Ctrl+S', async () => {
    const save = vi.fn(async (): Promise<WriteWorkspaceFileOutcome> => ({ kind: 'saved', version: 'v2' }))
    const onDirty = vi.fn()
    render(<EditableTextBody text="one" version="v1" save={save} reload={vi.fn()} onDirty={onDirty} labels={LABELS} />)
    fireEvent.change(area(), { target: { value: 'one two' } })
    // No timer, no write: the dot is the only thing that changes.
    expect(save).not.toHaveBeenCalled()
    expect(onDirty).toHaveBeenLastCalledWith(true)
    fireEvent.keyDown(area(), { key: 's', ctrlKey: true })
    await vi.waitFor(() => { expect(save).toHaveBeenCalledWith('one two', 'v1', expect.any(AbortSignal)) })
    await vi.waitFor(() => { expect(onDirty).toHaveBeenLastCalledWith(false) })
  })

  it('keeps a refused buffer and does not retry on its own', async () => {
    const save = vi.fn(async (): Promise<WriteWorkspaceFileOutcome> => ({ kind: 'stale' }))
    render(<EditableTextBody text="one" version="v1" save={save} reload={vi.fn()} onDirty={vi.fn()} labels={LABELS} />)
    fireEvent.change(area(), { target: { value: 'mine' } })
    fireEvent.keyDown(area(), { key: 's', ctrlKey: true })
    await vi.waitFor(() => { expect(screen.getByText('stale')).toBeDefined() })
    // Nothing was decided for the reader: their words are still on screen.
    expect(area().value).toBe('mine')
    // And the editor does not send again by itself.
    await Promise.resolve()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('adopts the Host text while untouched, and keeps the reader\'s once touched', () => {
    const { rerender } = render(
      <EditableTextBody text="one" version="v1" save={ignore} reload={vi.fn()} onDirty={vi.fn()} labels={LABELS} />,
    )
    rerender(<EditableTextBody text="one two" version="v2" save={ignore} reload={vi.fn()} onDirty={vi.fn()} labels={LABELS} />)
    expect(area().value).toBe('one two')
    fireEvent.change(area(), { target: { value: 'mine' } })
    rerender(<EditableTextBody text="theirs" version="v3" save={ignore} reload={vi.fn()} onDirty={vi.fn()} labels={LABELS} />)
    expect(area().value).toBe('mine')
    expect(screen.getByText('stale')).toBeDefined()
  })
})
