/** The Conversation's 「网页」 view: the same browser body, seated by a view instead of a dock tab. */
import { useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserInjected } from '../browser/BrowserController.ts'
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
const SURFACE_ID = 'conversation-web-view'

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
  const { loadUrl } = props
  // Stopping is the view's own business: a view that unmounts must not leave a page loaded behind
  // it, and a dock tab's signal is not this view's to end.
  const alive = useRef(new AbortController())
  useEffect(() => {
    const controller = alive.current
    return () => { controller.abort() }
  }, [])
  const surface = useMemo<BrowserSurface>(() => ({
    id: SURFACE_ID,
    signal: alive.current.signal,
    initialUrl: undefined,
    refreshShortcut: undefined,
    // No dock command reaches a view, so there is nothing to bind a refresh to.
    bindRefresh: () => undefined,
    // A page that asks for a new tab is asking to go there. The view has nowhere else to show it,
    // and the alternative — a window that opens blank, or nothing happening at all — is worse than
    // following the reader: so the link replaces this view's own page, in place.
    openTab: (url: string) => { loadUrl(SURFACE_ID, url) },
  }), [loadUrl])
  return <BrowserSurfaceBody {...props} surface={surface} />
}
