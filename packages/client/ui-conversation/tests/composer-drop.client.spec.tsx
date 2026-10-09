// @vitest-environment jsdom
/**
 * A path dropped on the composer is handed over, and nothing else is.
 *
 * The drag that matters comes from the file tree and carries a location, not bytes: the chip
 * it becomes holds the path. What these cases hold down is that the host claims a drag only
 * while somebody is listening — a composer nobody wired must not swallow a drop that belongs
 * to whatever is behind it — and that it hands over exactly the paths it was given.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ComposerContentEditable } from '../src/client/input/editor/ComposerContentEditable.tsx'

/** A data transfer carrying one payload, which is all this host reads. */
function transfer(text: string): { getData: (type: string) => string; dropEffect: string } {
  return {
    getData: (type: string) => (type === 'text/plain' ? text : ''),
    dropEffect: 'none',
  }
}

/** The composer host over a null editor: the inert state renders the same element. */
function host(onDropPaths?: (paths: readonly string[]) => void) {
  const view = render(
    <ComposerContentEditable
      editor={null}
      editable={false}
      {...onDropPaths === undefined ? {} : { onDropPaths }}
    />,
  )
  return view.container.querySelector('[data-composer-input]') as HTMLElement
}

describe('dropping a path on the composer', () => {
  afterEach(() => { cleanup() })

  it('hands over the dropped path', () => {
    const onDropPaths = vi.fn()
    const element = host(onDropPaths)
    fireEvent.drop(element, { dataTransfer: transfer('/work/notes.md') })
    expect(onDropPaths).toHaveBeenCalledExactlyOnceWith(['/work/notes.md'])
  })

  it('hands over several paths in the order they arrived', () => {
    const onDropPaths = vi.fn()
    const element = host(onDropPaths)
    fireEvent.drop(element, { dataTransfer: transfer('/work/a.py\n/work/b.py') })
    expect(onDropPaths).toHaveBeenCalledExactlyOnceWith(['/work/a.py', '/work/b.py'])
  })

  it('takes the drop and claims the drag while somebody is listening', () => {
    const element = host(() => undefined)
    const event = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: transfer('/work/a.py') })
    element.dispatchEvent(event)
    // Claimed, so the browser does not treat the drop as navigation.
    expect(event.defaultPrevented).toBe(true)
  })

  it('ignores a drag that carries no path', () => {
    const onDropPaths = vi.fn()
    const element = host(onDropPaths)
    fireEvent.drop(element, { dataTransfer: transfer('') })
    expect(onDropPaths).not.toHaveBeenCalled()
  })

  it('leaves an unwired composer alone rather than swallowing the drop', () => {
    const element = host()
    const event = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: transfer('/work/a.py') })
    element.dispatchEvent(event)
    // Nothing here will use the drop, so nothing here may claim it.
    expect(event.defaultPrevented).toBe(false)
  })
})
