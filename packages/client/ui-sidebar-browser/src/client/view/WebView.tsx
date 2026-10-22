/** The Conversation's 「网页」 view: the same browser body, seated by a view instead of a dock tab. */
import { useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserInjected } from '../browser/BrowserController.ts'
import { currentBrowserTarget } from '../browser/BrowserPersistence.ts'
import type { BrowserStore } from '../browser/store.ts'
import { BrowserSurfaceBody, type BrowserSurface, type BrowserSurfaceBodyProps } from './BrowserBody.tsx'

/**
 * The identity of the view's own browsing surface.
 *
 * A constant, and per Session because the slot is Session-scoped: the same view in two Sessions has
 * two surfaces, which is what a reader expects of two different conversations. It is a plain string
 * rather than a dock tab's identity because a view is not a dock tab — that is exactly what the
 * surface key was widened for.
 */
export const WEB_VIEW_SURFACE_ID = 'conversation-web-view'

/**
 * The view's browsing signal, held for the whole application rather than for one mount.
 *
 * mount disposes a surface only when its signal is a different one, so a signal that lived and
 * died with the component destroyed the page every time the reader looked at another view. This one
 * outlives every unmount, which is what makes the page stay where it was.
 */
const WEB_VIEW_SIGNAL = new AbortController()

/**
 * The last address this view showed, for the whole application rather than one Session.
 *
 * A Session that has never opened the view would otherwise show an empty address bar, because the
 * saved state belongs to the Session: the reader switching conversations expects to find the page
 * they were on, not a blank one.
 */
/** Where the last address is kept between runs: the in-memory value dies with a reload. */
const LAST_ADDRESS_KEY = 'dsh-sidebar-browser:last-address'

let lastAddress: string | undefined = ((): string | undefined => {
  try {
    return globalThis.localStorage.getItem(LAST_ADDRESS_KEY) ?? undefined
  } catch {
    // Storage can be denied; remembering nothing is the same as never having been here.
    return undefined
  }
})()

/** Props the view needs: its own runtime share plus what the browser body reads from any seat. */
export type WebViewProps = ConvViewProps
  & Pick<BrowserSurfaceBodyProps, 'mount' | 'loadUrl' | 'restore' | 'goBack' | 'goForward'
    | 'reload' | 'setSandbox' | 'useBrowserState' | 'useStore' | 't' | 'actions'>
  & PropsStore<BrowserStore>
  & PropsLocale<'sidebarBrowser'>
  & InjectFace<BrowserInjected>

/**
 * Render the browser inside the Conversation's 「网页」 view.
 *
 * The surface is this view's own: it stops when the view leaves, because a view has no dock command
 * to bind a refresh to and no second tab to open beside itself. Those two are written as the no-ops
 * they are rather than as something that pretends to work.
 * @param props - the view's runtime share and the browser's plugin face.
 * @returns the browser body over this view's surface.
 */
export function WebView(props: WebViewProps): ReactNode {
  const { loadUrl, useStore } = props
  // Stopping is the view's own business: a view that unmounts must not leave a page loaded behind
  // it, and a dock tab's signal is not this view's to end.

  // A saved checkpoint alone never starts a page — the controller says so itself — so the last
  // address this view recorded is handed back as its initial navigation. Taken ONCE, at mount: a
  // value that followed the store would change every time the page recorded a navigation, and a
  // changed surface remounts the body, which reloads the very page the reader is typing into — the
  // flicker, and the keystrokes that never arrive, both come from that.
  const saved = useStore(state => state.byTab[WEB_VIEW_SURFACE_ID])
  const savedUrl = currentBrowserTarget(saved)?.url
  // Remember it for the next Session that opens this view, and start from this Session's own
  // address when it has one.
  useEffect(() => {
    if (savedUrl === undefined) return
    lastAddress = savedUrl
    try {
      globalThis.localStorage.setItem(LAST_ADDRESS_KEY, savedUrl)
    } catch {
      // Storage can be denied; the in-memory value still serves this run.
    }
  }, [savedUrl])
  const firstUrl = useRef(savedUrl ?? lastAddress)
  const surface = useMemo<BrowserSurface>(() => ({
    id: WEB_VIEW_SURFACE_ID,
    signal: WEB_VIEW_SIGNAL.signal,
    initialUrl: firstUrl.current,
    refreshShortcut: undefined,
    // No dock command reaches a view, so there is nothing to bind a refresh to.
    bindRefresh: () => undefined,
    // A page that asks for a new tab is asking to go there. The view has nowhere else to show it,
    // and the alternative — a window that opens blank, or nothing happening at all — is worse than
    // following the reader: so the link replaces this view's own page, in place.
    openTab: (url: string) => { loadUrl(WEB_VIEW_SURFACE_ID, url) },
  }), [loadUrl])
  return <BrowserSurfaceBody {...props} surface={surface} />
}
