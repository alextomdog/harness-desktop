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

// What the editor case is about is that a quote NAMES the file it came from — not how an address
// is spelled, which the file-reference grammar already owns. So the parser is stubbed and this
// suite stays about the gesture.
/** Replies the gesture asked the composer to answer, reset between cases. */
const replies: unknown[] = []

/** Cleanups of every effect registered so far, run between cases. */
const cleanups: Array<() => void> = []

vi.mock('../src/client/rpc.ts', () => ({
  hostFileOf: (address: string) => ({ sessionId: 's1', path: address.split('/file/')[1] ?? 'paper/main.tex', address }),
}))

/**
 * A context with only what the gesture's own path touches.
 *
 * The row carries its OWN `id`, because that is what the gesture resolves a session to — a fake
 * without one makes `currentSession` return undefined and the gesture return in silence, which
 * is exactly the failure mode its own comment warns about.
 * @param sidebarRight - the sidebar service, when the case needs an active tab.
 */
function context(sidebarRight?: unknown): never {
  const row = { id: 's1', retainedBy: { mainView: 1 } }
  const sessions = {
    list: { getSnapshot: () => ({ byId: { s1: row } }) },
    // The gesture resolves the shell through a binding, which is how the hub does it too.
    binding: () => ({ session: 's1' }),
  }
  // What the gesture asked the composer to answer — the whole of the conversation case.
  const conversation = {
    input: { setReply: (_binding: unknown, target: unknown) => { replies.push(target) } },
  }
  return {
    // The cleanup is KEPT and run after each case: a listener that outlives its case keeps
    // answering the next case's press with the previous case's tab, which is exactly how one
    // case's file name turned up in another case's draft.
    effect: (run: () => () => void) => { cleanups.push(run()) },
    get: (name: string) => {
      if (name === 'sidebarRight') return sidebarRight
      if (name === 'sessions') return sessions
      if (name === 'conversation') return conversation
      return undefined
    },
  } as never
}

/**
 * Focus the composer holding one passage, selected whole.
 *
 * The composer IS the contenteditable the gesture inserts into, so a fixture without one has
 * nowhere to put a passage and would only be measuring that absence. Its text is selected as a
 * DOM range, which is how a selection outside a form field reaches this path.
 * @param passage - the text to select.
 * @returns the composer.
 */
function selectInComposer(passage: string): HTMLElement {
  const composer = document.createElement('div')
  composer.setAttribute('contenteditable', 'true')
  // Every preview carries its own address, which is what names the file a passage came from —
  // the same hook a PDF or an office document is rendered under.
  composer.setAttribute('data-textpreview-url', 'dsh-resource://file/paper/main.tex')
  composer.textContent = passage
  document.body.append(composer)
  const range = document.createRange()
  range.selectNodeContents(composer)
  const selection = window.getSelection() as Selection
  selection.removeAllRanges()
  selection.addRange(range)
  return composer
}

/** Press the gesture's key from wherever focus is, the way a real press travels. */
function pressQuote(): void {
  const target = document.activeElement ?? document.body
  target.dispatchEvent(new KeyboardEvent('keydown', {
    key: ' ', code: 'Space', shiftKey: true, bubbles: true, cancelable: true,
  }))
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
    while (cleanups.length > 0) cleanups.pop()?.()
    replies.length = 0
    document.body.innerHTML = ''
  })

  it('quotes an editor selection under the file it came from', async () => {
    selectInComposer('bool ready = true;')

    // The tab names its own address, and the file is what that address resolves to.
    installQuoteShortcut(context({ active: () => ({ contentId: 'dsh-resource://file/paper' }) }))
    pressQuote()

    // Every source now lands on the card: a file's passage is named by its file.
    // Both halves of the provenance: which file it came out of, and the passage itself.
    expect(replies[0]).toMatchObject({ text: 'bool ready = true;' })
  })

  it('names no file when the selection is in no preview at all', async () => {
    // A surface that is not a preview names nothing: naming a wrong file would be worse than
    // naming none, because a quote that lies about its source cannot be checked at all.
    const bare = document.createElement('div')
    bare.textContent = 'nothing names me'
    document.body.append(bare)
    const composer = document.createElement('div')
    composer.setAttribute('contenteditable', 'true')
    document.body.append(composer)
    const range = document.createRange()
    range.selectNodeContents(bare)
    const selection = window.getSelection() as Selection
    selection.removeAllRanges()
    selection.addRange(range)

    installQuoteShortcut(context())
    pressQuote()

    await vi.waitFor(() => { expect(replies).toHaveLength(1) })
  })

  it('names no file when the passage came from the conversation', async () => {
    // The reader selected TALK, not a file. A file tab being open in the sidebar says nothing
    // about what they selected, and writing its name into the draft would be a claim they never
    // made — the mistake this case exists to prevent.
    // The composer the passage goes INTO, which is always there — while the SELECTION is what
    // says where the passage came from, and here it came from the conversation.
    const composer = document.createElement('div')
    composer.setAttribute('contenteditable', 'true')
    const talk = document.createElement('div')
    talk.textContent = 'a passage from the conversation'
    document.body.append(composer, talk)
    const range = document.createRange()
    range.selectNodeContents(talk)
    const selection = window.getSelection() as Selection
    selection.removeAllRanges()
    selection.addRange(range)

    installQuoteShortcut(context({ active: () => ({ contentId: 'dsh-resource://file/paper' }) }))
    pressQuote()

    // The message is ANSWERED, not pasted: the draft keeps the reader's own words, and the
    // composer is told which message is being replied to.
    await vi.waitFor(() => { expect(replies).toHaveLength(1) })
    expect(replies[0]).toEqual({ text: 'a passage from the conversation' })
  })

  it('names a PDF when the passage came from one', async () => {
    // A PDF is read in its own surface, and a passage quoted out of it has to say which PDF — the
    // reader cannot check a quote against a document the draft never names.
    const page = document.createElement('div')
    page.setAttribute('data-textpreview-url', 'dsh-resource://file/paper/thesis.pdf')
    const text = document.createElement('p')
    text.textContent = 'a passage from the PDF'
    page.append(text)
    document.body.append(page)
    const composer = document.createElement('div')
    composer.setAttribute('contenteditable', 'true')
    document.body.append(composer)
    const range = document.createRange()
    range.selectNodeContents(text)
    const selection = window.getSelection() as Selection
    selection.removeAllRanges()
    selection.addRange(range)

    installQuoteShortcut(context())
    pressQuote()

    // A PDF is a source like any other now, and the card names it.
    expect(replies[0]).toMatchObject({ text: 'a passage from the PDF' })
  })

  it('reads a webview with the production expression and quotes it', async () => {
    const signal = signalSource()
    const page = mountWebview('quoted from the page')

    installQuoteShortcut(context())
    expect(signal.subscribed).toBe(true)
    signal.fire()

    // A page's passage is answered on the card too, which is the behaviour every other source has.
    // The expression now returns BOTH halves of the provenance: what was selected, and the page
    // it was selected on. A page is named by its address, so a quote can say where it came from.
    expect(page.asked[0]).toBe('JSON.stringify({ text: window.getSelection().toString(), url: location.href })')
    await vi.waitFor(() => { expect(replies).toHaveLength(1) })
    expect(replies[0]).toMatchObject({ text: 'quoted from the page' })
  })

  it('reads an embedded page, which has no webview to ask', () => {
    const signal = signalSource()
    document.body.innerHTML = '<div contenteditable="true"></div><iframe data-sidebar-browser-frame></iframe>'
    const embedded = document.querySelector('iframe') as HTMLIFrameElement
    selectInFrame(embedded, 8)

    installQuoteShortcut(context())
    signal.fire()

    expect(replies[0]).toMatchObject({ text: expect.stringContaining('embedded') })
    expect(replies[0]).toMatchObject({ text: expect.stringContaining('embedded') })
  })

  it('does nothing when the page has no selection', async () => {
    const signal = signalSource()
    mountWebview('')

    installQuoteShortcut(context())
    signal.fire()

    await Promise.resolve()
    await Promise.resolve()
  })
})
