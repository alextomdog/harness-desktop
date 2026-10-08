// @vitest-environment jsdom
/**
 * The quote gesture reads a page's selection from this window, not from the shell.
 *
 * The shell cannot be exercised from outside the main process, and CDP-injected keys never
 * reach its input hook, so this path is the one that has to be pinned down by a test: the
 * signal arrives, the window reads the webview element it owns, and the passage goes into
 * the composer through the same call the other two selections use.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installQuoteShortcut } from '../src/client/quote-selection.ts'

/** A context with only what the gesture's own path touches. */
function context(): never {
  return {
    effect: (run: () => () => void) => { run(); return () => undefined },
    get: () => undefined,
  } as never
}

/** A signal source standing in for the preload bridge, capturing its listener. */
function signalSource(): { readonly fire: () => void; readonly subscribed: boolean } {
  let listener: (() => void) | undefined
  vi.stubGlobal('dshDesktop', {
    quotes: {
      subscribe: (next: () => void) => {
        listener = next
        return () => undefined
      },
    },
  })
  return {
    get subscribed() { return listener !== undefined },
    fire: () => { listener?.() },
  }
}

// jsdom has no `execCommand` at all, so the insertion point is defined before it is spied on.
Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: () => true })
describe('quoting a page selection', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('reads the page through the webview element and puts the passage in the composer', async () => {
    const signal = signalSource()
    document.body.innerHTML = '<div contenteditable="true"></div><webview data-sidebar-browser-frame></webview>'
    const frame = document.querySelector('webview') as HTMLElement & { executeJavaScript: (code: string) => Promise<unknown> }
    const asked: string[] = []
    frame.executeJavaScript = (code: string) => {
      asked.push(code)
      return Promise.resolve('quoted from the page')
    }
    const inserted: string[] = []
    vi.spyOn(document, 'execCommand').mockImplementation((_command: string, _show?: boolean, value?: string) => {
      inserted.push(String(value))
      return true
    })

    installQuoteShortcut(context())
    expect(signal.subscribed).toBe(true)
    signal.fire()

    await vi.waitFor(() => { expect(inserted.join('')).toContain('quoted from the page') })
    // The reading half is the production expression, not something the test invented.
    expect(asked[0]).toBe('window.getSelection().toString()')
    // A quote arrives as a quote, so the caret is left after it for the reader's question.
    expect(inserted.join('')).toContain('> quoted from the page')
  })

  it('does nothing when the page has no selection', async () => {
    const signal = signalSource()
    document.body.innerHTML = '<div contenteditable="true"></div><webview data-sidebar-browser-frame></webview>'
    const frame = document.querySelector('webview') as HTMLElement & { executeJavaScript: (code: string) => Promise<unknown> }
    frame.executeJavaScript = () => Promise.resolve('')
    const inserted: string[] = []
    vi.spyOn(document, 'execCommand').mockImplementation((_command: string, _show?: boolean, value?: string) => {
      inserted.push(String(value))
      return true
    })

    installQuoteShortcut(context())
    signal.fire()

    // Give the promise a turn before asserting that nothing happened.
    await Promise.resolve()
    await Promise.resolve()
    expect(inserted).toEqual([])
  })
})
