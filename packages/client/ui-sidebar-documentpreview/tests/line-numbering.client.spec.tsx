// @vitest-environment jsdom
/**
 * A line number belongs to its own line, wrapped or not.
 *
 * The gutter used to be a column of its own, one entry per line, which silently drifted: a
 * line that wraps occupies more than one row of text but exactly one entry in that column, so
 * from the first wrapped line onwards every number sat beside a line it did not belong to —
 * off by the number of wrapped rows above it. The fix was structural, so the test is too:
 * the number lives INSIDE its line's own element, which is what makes it impossible for it to
 * lag. jsdom has no layout, so position is asserted through that containment rather than
 * through pixels — and that containment is the actual invariant.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { EditableTextBody } from '../src/client/editable/EditableTextBody.tsx'

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

/** A save that never settles: nothing here writes a file. */
const neverSaves = (): Promise<never> => new Promise<never>(() => undefined)

/**
 * Render the editor over one text.
 * @param text - the file's content.
 * @returns the rendered container.
 */
function editor(text: string) {
  return render(
    <EditableTextBody
      text={text}
      version="v1"
      save={neverSaves}
      reload={() => undefined}
      onDirty={() => undefined}
      labels={LABELS}
    />,
  ).container
}

/** Every painted line, in order. */
function lines(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll('[data-textpreview-highlight] > div')] as HTMLElement[]
}

describe('line numbering', () => {
  it('keeps the reading position when the text arrives again', async () => {
    const props = {
      version: 'v1',
      save: () => new Promise<never>(() => undefined),
      reload: () => undefined,
      onDirty: () => undefined,
      labels: LABELS,
    }
    const view = render(<EditableTextBody {...props} text={'line\n'.repeat(400)} />)
    const before = view.container.querySelector<HTMLTextAreaElement>('[data-textpreview-textarea]')
    expect(before).not.toBeNull()
    // jsdom has no layout, so the offset is set rather than scrolled to — which is exactly the
    // value the editor has to carry across the update.
    if (before !== null) before.scrollTop = 120

    // The Host's text arrives again, as it does after a save.
    view.rerender(<EditableTextBody {...props} version="v2" text={'line\n'.repeat(400) + 'tail'} />)
    await new Promise((resolve) => { requestAnimationFrame(() => { resolve(undefined) }) })

    const after = view.container.querySelector<HTMLTextAreaElement>('[data-textpreview-textarea]')
    // Assigning a controlled textarea's value resets its scroll; being thrown back to the first
    // line after every Ctrl+S is the bug this holds shut.
    expect(after?.scrollTop).toBe(120)
  })
  it('indents with four spaces when Tab is pressed', () => {
    const container = editor('alpha\nbeta')
    const area = container.querySelector<HTMLTextAreaElement>('[data-textpreview-textarea]')
    expect(area).not.toBeNull()

    // `fireEvent`, not a raw dispatch: React's handlers are reached through its own system, and a
    // bare dispatchEvent on the node never gets there. The indent lands in the editor's buffer, so
    // the assertion is on the text the editor ends up holding.
    act(() => {
      area?.focus()
      area?.setSelectionRange(0, 0)
    })
    fireEvent.keyDown(area as HTMLTextAreaElement, { key: 'Tab', code: 'Tab' })

    // Four spaces, the width this project indents with: a document must not come back from this
    // editor indented at a width its own project does not use.
    const after = container.querySelector<HTMLTextAreaElement>('[data-textpreview-textarea]')
    expect(after?.value).toBe('    alpha\nbeta')
  })
  afterEach(() => { cleanup() })

  it('numbers every line, in order, starting at one', () => {
    const container = editor('alpha\nbeta\ngamma')
    const rows = lines(container)
    expect(rows).toHaveLength(3)
    expect(rows.map(row => row.querySelector('[data-textpreview-line-number]')?.textContent))
      .toEqual(['1', '2', '3'])
  })

  it('keeps each number inside its own line, which is what stops it lagging', () => {
    const container = editor('alpha\nbeta\ngamma\ndelta')
    for (const [index, row] of lines(container).entries()) {
      const number = row.querySelector('[data-textpreview-line-number]')
      // Inside the line it numbers — not in a parallel column that could drift away from it.
      expect(number).not.toBeNull()
      expect(number?.parentElement).toBe(row)
      expect(number?.textContent).toBe(String(index + 1))
    }
  })

  it('gives a line that wraps exactly one number, on that line', () => {
    const long = 'x'.repeat(400)
    const container = editor(`${long}\nshort`)
    const rows = lines(container)
    // Two logical lines, whatever the browser does with the long one on screen.
    expect(rows).toHaveLength(2)
    expect(rows[0]?.querySelectorAll('[data-textpreview-line-number]')).toHaveLength(1)
    expect(rows[0]?.querySelector('[data-textpreview-line-number]')?.textContent).toBe('1')
    // The number after a wrapped line is still its own line's, not one behind it.
    expect(rows[1]?.querySelector('[data-textpreview-line-number]')?.textContent).toBe('2')
  })

  it('counts a line with no text as a line, so the numbers keep matching the file', () => {
    const container = editor('alpha\n\n\ndelta')
    const rows = lines(container)
    expect(rows).toHaveLength(4)
    expect(rows.map(row => row.querySelector('[data-textpreview-line-number]')?.textContent))
      .toEqual(['1', '2', '3', '4'])
    // A blank line's row still belongs to that line: its number is there, its text is not.
    expect(rows[1]?.textContent).toBe('2')
  })
})
