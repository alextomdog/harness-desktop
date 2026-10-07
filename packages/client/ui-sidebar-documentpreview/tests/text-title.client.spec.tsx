// @vitest-environment jsdom
/**
 * The chip title: the file type's sheet, the name the registry captured, and —
 * when the tab holds unsaved edits — the dot an editor shows.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { TextTitleProps } from '../src/client/TextTitle.tsx'
import { TextTitle } from '../src/client/TextTitle.tsx'
import { fresh, type TextState } from '../src/client/store.ts'

afterEach(cleanup)

/** The title's props over one tab, clean or dirty. */
function props(title: string, dirty = false): TextTitleProps {
  const state = { byTab: { t1: { ...fresh(), dirty } } } as unknown as TextState
  return {
    useTabInfo: () => ({ tab: { id: 't1', title } }),
    useStore: (select: (value: TextState) => unknown) => select(state),
    actions: {},
    t: (key: string) => key,
  } as unknown as TextTitleProps
}

describe('TextTitle', () => {
  it('draws the type sheet before the title text, sized to the chip line', () => {
    const { container } = render(<TextTitle {...props('README.md')} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('16')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(container.textContent).toBe('README.md')
  })

  it('picks the sheet from the title\'s extension', () => {
    const markdown = render(<TextTitle {...props('notes.md')} />).container.querySelector('svg')?.innerHTML
    const pdf = render(<TextTitle {...props('paper.pdf')} />).container.querySelector('svg')?.innerHTML
    expect(markdown).not.toBe(pdf)
  })

  it('marks unsaved work with a dot, and draws none once the tab is clean', () => {
    const dirty = render(<TextTitle {...props('README.md', true)} />).container
    expect(dirty.querySelector('[data-textpreview-dirty]')).not.toBeNull()
    cleanup()
    const clean = render(<TextTitle {...props('README.md')} />).container
    expect(clean.querySelector('[data-textpreview-dirty]')).toBeNull()
  })
})
