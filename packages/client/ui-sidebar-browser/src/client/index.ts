/** Register the HTTP(S) Browser tab type in the right Sidebar. */
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { Context } from '@deepseek-ai/cordis'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { BrowserBody, type BrowserBodyProps } from './view/BrowserBody.tsx'
import { WEB_VIEW_SURFACE_ID, WebView } from './view/WebView.tsx'
import { BrowserTitle } from './view/BrowserTitle.tsx'
import { createBrowserControllers } from './browser/BrowserController.ts'
import type { BrowserInjected } from './browser/BrowserController.ts'
import { createIframePage } from './pages.ts'
import { createElectronPage } from './electron/pages.ts'
import type { DesktopBrowserBridge } from '../types.ts'
import { browserWorkspace } from './electron/workspace.ts'
import type { BrowserPageFactory } from './browser/BrowserPage.ts'
import { BROWSER_ID, browserDefinition } from './definition.tsx'
import { en, zh } from './locales.ts'
import { createBrowserStore } from './browser/store.ts'

export type { BrowserBodyProps } from './view/BrowserBody.tsx'
export type { BrowserControllerState, BrowserInjected, BrowserMountRequest } from './browser/BrowserController.ts'
export type { BrowserFrame, BrowserFrameState, BrowserLoadError, BrowserSandboxControl } from './browser/BrowserFrame.ts'
export type { BrowserPage, BrowserPageFactory, BrowserPageOptions } from './browser/BrowserPage.ts'
export type { BrowserPresentation } from './view/BrowserPresentation.ts'
export type { BrowserFailure, BrowserHistoryEntry, BrowserNavigationStatus, BrowserTabState } from './browser/BrowserPersistence.ts'
export type { SidebarBrowserKey } from './locales.ts'
export type { BrowserState } from './browser/store.ts'
export type { BrowserAddressFailure, BrowserAddressResult, BrowserTarget } from './browser/url.ts'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** Optional initial Browser URL. */
    browser: { readonly url?: string }
  }
}

/** Required Browser services. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

/** Registered identity of the Conversation View the Browser seats itself in. */
export const WEB_VIEW_ID = 'web'

/** What this View's composer takeover hands its (silent) component. */
interface WebViewComposerTaken {
  readonly taken: true
}

/**
 * The 「网页」 View is not part of the Conversation, so the Conversation's
 * composer is not part of it either: this entry takes the seat for the View and
 * renders nothing, which leaves the whole frame to the page.
 *
 * Nothing is lost by taking it: the chain's `overlay` keeps the fallback
 * MOUNTED under an election (hidden, not unmounted), so a draft typed in Chat
 * is still there when the reader comes back to it.
 * @returns nothing, deliberately.
 */
function NoWebViewComposer(): null {
  return null
}

/** Register the Browser type, localized guide entry, body, and title. */
export function apply(ctx: Context): void {
  const namespace = 'sidebarBrowser'
  const t = ctx.locale.bind(namespace)
  ctx.inject(['shortcuts'], (ctx) => {
    ctx.effect(() => ctx.shortcuts.register({
      id: 'browser.new' as ShortcutCommandId, label: () => t('guide.title'), aliases: ['browser', 'new browser tab'],
      defaults: {
        'desktop:macos': { code: 'KeyT', modifiers: ['primary'] },
        'desktop:windows': { code: 'KeyT', modifiers: ['primary'] },
        'desktop:linux': { code: 'KeyT', modifiers: ['primary'] },
        'web:macos': { code: 'KeyT', modifiers: ['primary', 'alt'] },
        'web:windows': { code: 'KeyT', modifiers: ['primary', 'alt'] },
      },
      // Each tab plugin owns its command's availability, localized refusal, and tab kind.
      /* jscpd:ignore-start */
      regions: ['page', 'editable', 'terminal'], modals: [],
      resolve: ({ target: element }) => {
        const target = ctx.sidebarRight.commandTarget(element)
        if (target === undefined) return { status: 'blocked', reason: t('shortcut.noSession') }
        return { status: 'handled', run: () => { ctx.sidebarRight.openTabFromTarget('browser', target) } }
      },
      /* jscpd:ignore-end */
    }), 'ui-sidebar-browser: shortcut')
  })
  const store = createBrowserStore()
  const openTabs = ctx.sidebarRight.openTabs
  const carrier = (globalThis as typeof globalThis & {
    dshDesktop?: { readonly protocolVersion: number; readonly browser?: DesktopBrowserBridge }
  }).dshDesktop
  const desktop = carrier?.protocolVersion === 1 ? carrier.browser : undefined
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'ui-sidebar-browser.copy')
  ctx.effect(() => ctx.sidebarRightTabs.register({ ...browserDefinition(t), keepMounted: desktop !== undefined }), 'ui-sidebar-browser.type')
  const installFrames = (scope: Context, factory: (sessionId: BrowserBodyProps['sessionId']) => BrowserPageFactory): void => {
    const controllers = new Map<BrowserBodyProps['sessionId'], BrowserInjected>()
    scope.effect(() => async () => {
      const pending = [...controllers.values()].map(controller => controller.dispose())
      controllers.clear()
      await Promise.all(pending)
    }, 'ui-sidebar-browser.frames')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: BROWSER_ID, locale: namespace, store,
      inject: (sessionId, actions) => {
        const existing = controllers.get(sessionId)
        if (existing !== undefined) {
          existing.rebind(actions)
          return existing
        }
        // The view is a resident, not a dock tab: it is always in the view list, so its surface is
        // always in use. Saying otherwise let the release path forget its saved page, which is why
        // coming back to the view showed nothing at all.
        const controller = createBrowserControllers(actions, factory(sessionId), tabId =>
          tabId === WEB_VIEW_SURFACE_ID
          || openTabs.getSnapshot().some(tab => tab.sessionId === sessionId && tab.tabId === tabId))
        controllers.set(sessionId, controller)
        return controller
      },
    }, BrowserBody)), 'ui-sidebar-browser.body')
    // The same browser, seated in the Conversation as its 「网页」 view. It reuses this
    // scope's controllers and factory, so the two seats share one browser per Session —
    // which is right, because the state is keyed by surface and the surfaces differ.
    scope.effect(() => scope.slots.inject('conversation.view', () => scope.slots.register({
      name: 'conversation.view', id: WEB_VIEW_ID, order: 20, locale: namespace, store,
      label: () => t('view.web'),
      inject: (sessionId, actions) => {
        const existing = controllers.get(sessionId)
        if (existing !== undefined) {
          existing.rebind(actions)
          return existing
        }
        // The view is a resident, not a dock tab: it is always in the view list, so its surface is
        // always in use. Saying otherwise let the release path forget its saved page, which is why
        // coming back to the view showed nothing at all.
        const controller = createBrowserControllers(actions, factory(sessionId), tabId =>
          tabId === WEB_VIEW_SURFACE_ID
          || openTabs.getSnapshot().some(tab => tab.sessionId === sessionId && tab.tabId === tabId))
        controllers.set(sessionId, controller)
        return controller
      },
    }, WebView)), 'ui-sidebar-browser.webView')
  }
  if (desktop === undefined) installFrames(ctx, () => createIframePage)
  else ctx.inject(['workspaces'], (scope) => {
    installFrames(scope, sessionId => options => createElectronPage(options, desktop,
      signal => browserWorkspace(scope.workspaces.list, sessionId, signal)))
  })
  // While the 「网页」 View is the one on screen, the Conversation's own composer
  // is not wanted under it: the entry below renders nothing, so the page keeps
  // the frame the input card used to take. Priority 10 deliberately trails every
  // interaction takeover (a read-only subagent at -10, a question at 0, an
  // approval at 1) — those are how a blocked agent gets answered, and burying
  // one behind a web page would strand it. Only the ordinary composer is taken.
  ctx.effect(() => ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    priority: 10,
    select: (owner: ComposerChainProps): WebViewComposerTaken | null =>
      owner.view === WEB_VIEW_ID ? { taken: true } : null,
  }, NoWebViewComposer)), 'ui-sidebar-browser.composer')
  // A page the Host asked for, opened through the app's own tab API — the same call a
  // chat link makes — so an agent facing an empty sidebar still gets something to drive.
  if (desktop !== undefined) {
    ctx.effect(() => desktop.onNewPage((url) => {
      ctx.sidebarRight.openTab('browser', { params: { url } })
    }), 'ui-sidebar-browser: host page')
  }
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: BROWSER_ID, store,
  }, BrowserTitle)), 'ui-sidebar-browser.title')
}
