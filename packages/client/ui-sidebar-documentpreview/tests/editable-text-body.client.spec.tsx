// @vitest-environment jsdom
/**
 * The editor's own contract: typing saves once it rests, the save carries the
 * version the buffer came from, and a refusal stops the timer and asks the reader
 * which side wins instead of guessing.
 *
 * The last case is the one that protects the reader's words: a file written
 * underneath them must not replace what they are typing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EditableTextBody } from '../src/client/editable/EditableTextBody.tsx'
import type { EditableTextLabels } from '../src/client/editable/EditableTextBody.tsx'
import type { WriteWorkspaceFileOutcome } from '../src/client/rpc.ts'

const LABELS: EditableTextLabels = {
  saving: 'saving', saved: 'saved', stale: 'stale', keepMine: 'keep',
  useDisk: 'disk', failed: 'failed', editAria: 'contents',
}

/** The textarea, read back as the reader sees it. */
function area(): HTMLTextAreaElement {
  return screen.getByLabelText('contents') as HTMLTextAreaElement
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('EditableTextBody', () => {
  it('saves what was typed, under the version it was read at, once typing rests', async () => {
    vi.useFakeTimers()
    const save = vi.fn(async (): Promise<WriteWorkspaceFileOutcome> => ({ kind: 'saved', version: 'v2' }))
    render(<EditableTextBody text="one" version="v1" save={save} reload={vi.fn()} labels={LABELS} />)
    fireEvent.change(area(), { target: { value: 'one two' } })
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(700)
    expect(save).toHaveBeenCalledWith('one two', 'v1', expect.any(AbortSignal))
    expect(screen.getByText('saved')).toBeDefined()
  })

  it('stops on a refusal, keeps the reader\'s text, and offers the two sides', async () => {
    vi.useFakeTimers()
    const save = vi.fn(async (): Promise<WriteWorkspaceFileOutcome> => ({ kind: 'stale' }))
    render(<EditableTextBody text="one" version="v1" save={save} reload={vi.fn()} labels={LABELS} />)
    fireEvent.change(area(), { target: { value: 'mine' } })
    await vi.advanceTimersByTimeAsync(700)
    expect(save).toHaveBeenCalledTimes(1)
    expect(screen.getByText('stale')).toBeDefined()
    // Nothing was decided for the reader: their words are still on screen.
    expect(area().value).toBe('mine')
    // And the timer does not send again while the conflict stands.
    await vi.advanceTimersByTimeAsync(3000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('adopts the Host text while untouched, and keeps the reader\'s once touched', () => {
    const { rerender } = render(
      <EditableTextBody text="one" version="v1" save={vi.fn()} reload={vi.fn()} labels={LABELS} />,
    )
    rerender(<EditableTextBody text="one two" version="v2" save={vi.fn()} reload={vi.fn()} labels={LABELS} />)
    expect(area().value).toBe('one two')
    fireEvent.change(area(), { target: { value: 'mine' } })
    rerender(<EditableTextBody text="theirs" version="v3" save={vi.fn()} reload={vi.fn()} labels={LABELS} />)
    expect(area().value).toBe('mine')
    expect(screen.getByText('stale')).toBeDefined()
  })
})
