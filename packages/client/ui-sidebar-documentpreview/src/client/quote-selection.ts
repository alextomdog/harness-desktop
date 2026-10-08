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
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
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
function quoteInto(ctx: Context, sessionId: string, quote: string): void {
  const sessions = ctx.get('sessions')
  const inputTriggers = ctx.get('inputTriggers')
  const actx = sessions?.scope(sessionId as never)
  const controller = actx === undefined ? undefined : inputTriggers?.sessionOf(actx)
  if (controller === undefined) return
  controller.openReference(undefined, {
    ref: quote.slice(0, MAX_QUOTE),
    appearance: 'text',
  })
}

/**
 * Register the quote gesture.
 * @param ctx - the preview plugin's context.
 */
export function installQuoteShortcut(ctx: Context): void {
  // Scoped rather than declared on the plugin: the preview does not need the composer to
  // render a document, and a deployment without one must still draw files.
  ctx.inject(['shortcuts', 'sessions', 'inputTriggers', 'locale'], (scope) => {
    const t = scope.locale.bind('sidebarDocumentPreview')
    scope.effect(() => scope.shortcuts.register({
      id: 'composer.quoteSelection' as ShortcutCommandId,
      label: () => t('quote.label'),
      aliases: ['quote selection', 'quote into chat'],
      defaults: {
        'desktop:macos': { code: 'Space', modifiers: ['shift'] },
        'desktop:windows': { code: 'Space', modifiers: ['shift'] },
        'desktop:linux': { code: 'Space', modifiers: ['shift'] },
        'web:macos': { code: 'Space', modifiers: ['shift'] },
        'web:windows': { code: 'Space', modifiers: ['shift'] },
      },
      // Everywhere a selection can be made: the page, an editor, a terminal.
      regions: ['page', 'editable', 'terminal'], modals: [],
      resolve: () => {
        const quote = selectedText().trim()
        const session = Object.values(scope.sessions.list.getSnapshot().byId)
          .find(row => (row.retainedBy.mainView ?? 0) > 0)
        if (session === undefined) return { status: 'blocked', reason: t('quote.noSession') }
        if (quote === '') return { status: 'blocked', reason: t('quote.noSelection') }
        return { status: 'handled', run: () => { quoteInto(scope, session.id, quote) } }
      },
    }), 'ui-sidebar-documentpreview: quote selection')
  })
}
