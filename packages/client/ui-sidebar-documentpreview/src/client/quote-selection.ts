/**
 * Shift+Space quotes what the reader has selected into the composer.
 *
 * Selecting a passage and asking about it is the most common thing a reader wants from a
 * document, a page, or the conversation itself, and the gesture should not depend on which
 * of them has focus: the same keys quote the editor's selection, the page's, or the
 * transcript's.
 *
 * The selection is inserted as a TEXT reference rather than concatenated into the draft,
 * because the composer already models a reference as a span of the draft with an owner —
 * passing no owner is exactly what a text reference is — and a reference stays legible as
 * a chip instead of turning into a wall of quoted prose the reader then has to edit around.
 *
 * A blocked resolve is the honest answer for both ways this can do nothing: no session to
 * put the quote in, or nothing selected. The shortcut says which, in the reader's language.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'

/** Longest passage quoted in one gesture; a whole screen of prose is not a citation. */
const MAX_QUOTE = 4_000

/**
 * The text the reader has selected, wherever the selection lives.
 *
 * A focused text field owns its selection and reports it as offsets — which a page's own
 * `getSelection()` does not see, because a textarea's selection is not a DOM range. Every
 * other selection is a DOM range, and the transcript's selections are exactly that.
 * @returns the selected text, or the empty string when nothing is selected.
 */
function selectedText(): string {
  const active = document.activeElement
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    const { selectionStart, selectionEnd, value } = active
    if (selectionStart !== null && selectionEnd !== null && selectionEnd > selectionStart) {
      return value.slice(selectionStart, selectionEnd)
    }
  }
  return window.getSelection()?.toString() ?? ''
}

/**
 * Put one passage into the session's composer as a reference.
 * @param ctx - the scope that resolved the shortcut.
 * @param sessionId - the session the reader is looking at.
 * @param quote - the selected text.
 */
/**
 * Put one passage into the composer, as a quote the reader can type after.
 * @param quote - the selected text.
 */
function quoteInto(quote: string): void {
  // The passage goes in as TEXT, not as a chip, and that is a decision rather than a
  // shortcut. A chip has to name an owning reference source, and a source is a whole menu
  // group with candidates and pick handling: registering one just to quote would put a
  // "selection" group into the composer's own menus, which is a side effect of a different
  // feature. Quoting as text needs neither, and it is what the reader asked for — the
  // passage in the draft, with the caret after it, ready for a question.
  //
  // `insertText` is the same path the composer already accepts typed and pasted text on, so
  // the draft, its undo history and its height all behave exactly as they do for typing.
  const composer = document.querySelector<HTMLElement>('[contenteditable=true]')
  if (composer === null) return
  composer.focus()
  const quoted = quote.slice(0, MAX_QUOTE).split('\n').map(line => `> ${line}`).join('\n')
  document.execCommand('insertText', false, `${quoted}\n\n`)
}

/**
 * Register the quote gesture.
 * @param ctx - the preview plugin's context.
 */
/**
 * The session the reader is looking at.
 *
 * The main view's session when one is marked, and otherwise the most recent one: quoting has
 * to work in a window whose session the view has not marked yet, and refusing then would be
 * refusing for a reason the reader cannot see or act on.
 * @param ctx - the plugin's context.
 * @returns the session to quote into, or undefined when there is none.
 */
function currentSession(ctx: Context): string | undefined {
  // `ctx.get`, not `ctx.sessions`: reading a service off the context without declaring it
  // THROWS, and inside a key handler that throw is invisible — the gesture simply does
  // nothing, which is what it did for several rounds while looking like a binding problem.
  const sessions = ctx.get('sessions')
  if (sessions === undefined) return undefined
  const rows = Object.values(sessions.list.getSnapshot().byId)
  const main = rows.find(row => (row.retainedBy.mainView ?? 0) > 0)
  const chosen = main ?? rows[rows.length - 1]
  if (chosen === undefined) return undefined
  return chosen.id
}

export function installQuoteShortcut(ctx: Context): void {
  // Nothing to capture where there is no window: the plugin must still register its types in
  // a non-DOM environment (and in the specs that mount it with a partial context).
  if (typeof window === 'undefined') return

  // A selection made in the transcript does not survive to the key press. The composer is a
  // Lexical editor, and it syncs the DOM selection back to its own caret — so by the time
  // `keydown` runs, the passage the reader highlighted is no longer the window's selection,
  // which is why quoting from the conversation did nothing while quoting from the editor's
  // own field worked. Remembering the last non-empty selection is what keeps the gesture
  // honest: the fallback is used only when nothing is selected at the moment of the press.
  let remembered = ''
  const rememberSelection = (): void => {
    const text = selectedText()
    if (text !== '') remembered = text
  }
  document.addEventListener('selectionchange', rememberSelection)
  // Captured at the page rather than registered as a command, for two reasons that are both
  // about the gesture being what it is. Shift+Space is a TYPING key with a modifier, and the
  // command registry binds letters — a Space binding is never matched, which is how this
  // gesture first shipped doing nothing at all. And the gesture must work wherever a
  // selection can be made, including inside the editor's own field, without the registry
  // having to agree about which region that field belongs to.
  //
  // Capture phase, so the editor's own key handling never sees the key: a quote is not a
  // space the reader meant to type.
  ctx.effect(() => {
    // A page's selection belongs to the page, so the shell reads it and hands it over; the
    // insertion is the same call the editor's and the conversation's selections already make.
    const products = (globalThis as {
      dshDesktop?: { quotes?: { subscribe: (listener: (text: string) => void) => () => void } }
    }).dshDesktop
    const unsubscribe = products?.quotes?.subscribe((text: string) => {
      if (text.trim() !== '') quoteInto(text)
    })
    return () => { unsubscribe?.() }
  }, 'ui-sidebar-documentpreview: quoted page selections')

  // Through `effect`, so the listener is taken back when the plugin is: a key handler that
  // outlives its plugin keeps answering presses with a context that is gone.
  ctx.effect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const isSpace = event.code === 'Space' || event.key === ' '
      if (!event.shiftKey || !isSpace) return
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const quote = (selectedText() || remembered).trim()
      if (quote === '') return
      const sessionId = currentSession(ctx)
      if (sessionId === undefined) return
      event.preventDefault()
      event.stopPropagation()
      // One press, one quote: a remembered passage must not be quotable twice by accident.
      remembered = ''
      quoteInto(quote)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      document.removeEventListener('selectionchange', rememberSelection)
    }
  }, 'ui-sidebar-documentpreview: quote selection')
}
