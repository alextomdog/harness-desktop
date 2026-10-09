// @vitest-environment jsdom
/**
 * The quote gesture reads a page's selection from this window, not from the shell.
 *
 * The shell cannot be exercised from outside the main process, and CDP-injected keys never
 * reach its input hook, so this path is the one that has to be pinned down by a test: the
 * signal arrives, the window reads the page it owns, and the passage goes into the composer
 * through the same call the other two selections use. A page is either a webview (its own
 * process) or an iframe, and the gesture has to work in whichever the sidebar chose.
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

/**
 * jsdom has no `execCommand`, so the insertion point is defined rather than reached for.
 * @returns the values the composer was asked to insert.
 */
function recordInsertion(): string[] {
  const inserted: string[] = []
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    writable: true,
    value: (_command: string, _show?: boolean, value?: string) => {
      inserted.push(String(value))
      return true
    },
  })
  return inserted
}

/** A mounted webview element whose reading is observable. */
function mountWebview(read: string): { readonly asked: string[] } {
  document.body.innerHTML = '<div contenteditable="true"></div><webview data-sidebar-browser-frame></webview>'
  const asked: string[] = []
  const frame = document.querySelector('webview') as HTMLElement & { executeJavaScript: (code: string) => Promise<unknown> }
  frame.executeJavaScript = (code: string) => {
    asked.push(code)
    return Promise.resolve(read)
  }
  return { asked }
}

/** Select the first characters of the embedded document's first paragraph. */
function selectInFrame(embedded: HTMLIFrameElement, end: number): void {
  const inner = embedded.contentDocument as Document
  inner.body.innerHTML = '<p>embedded page passage</p>'
  const node = inner.querySelector('p')?.firstChild ?? inner.body
  const range = inner.createRange()
  range.setStart(node, 0)
  range.setEnd(node, end)
  const selection = inner.getSelection() as Selection
  selection.removeAllRanges()
  selection.addRange(range)
}

describe('quoting a page selection', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('reads a webview with the production expression and quotes it', async () => {
    const signal = signalSource()
    const page = mountWebview('quoted from the page')
    const inserted = recordInsertion()

    installQuoteShortcut(context())
    expect(signal.subscribed).toBe(true)
    signal.fire()

    await vi.waitFor(() => { expect(inserted.join('')).toContain('quoted from the page') })
    // The expression now returns BOTH halves of the provenance: what was selected, and the page
    // it was selected on. A page is named by its address, so a quote can say where it came from.
    expect(page.asked[0]).toBe('JSON.stringify({ text: window.getSelection().toString(), url: location.href })')
    expect(inserted.join('')).toContain('> quoted from the page')
  })

  it('reads an embedded page, which has no webview to ask', () => {
    const signal = signalSource()
    document.body.innerHTML = '<div contenteditable="true"></div><iframe data-sidebar-browser-frame></iframe>'
    const embedded = document.querySelector('iframe') as HTMLIFrameElement
    selectInFrame(embedded, 8)
    const inserted = recordInsertion()

    installQuoteShortcut(context())
    signal.fire()

    expect(inserted.join('')).toContain('embedded')
    expect(inserted.join('')).toContain('> ')
  })

  it('does nothing when the page has no selection', async () => {
    const signal = signalSource()
    mountWebview('')
    const inserted = recordInsertion()

    installQuoteShortcut(context())
    signal.fire()

    await Promise.resolve()
    await Promise.resolve()
    expect(inserted).toEqual([])
  })
})
