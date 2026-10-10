/** Persisted Browser tab snapshots shared by the body and title slots. */
/**
 * Identity of one browsing surface, wherever it is shown.
 *
 * Deliberately a plain string rather than the dock's branded tab identity: a surface is not
 * necessarily a dock tab — a conversation view can show one too — and this store only ever uses the
 * value as an opaque key. Widening it here is what lets a tab's own identity flow in without a cast.
 */
export type BrowserSurfaceId = string
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { BrowserTabState } from './BrowserPersistence.ts'

/** All Browser tabs in one Session-scoped store. */
export interface BrowserState {
  byTab: Record<BrowserSurfaceId, BrowserTabState>
}

type BrowserActions = {
  replace: (draft: BrowserState, surfaceId: BrowserSurfaceId, state: BrowserTabState) => void
  forget: (draft: BrowserState, surfaceId: BrowserSurfaceId) => void
}

/**
 * Declare the Session-scoped Browser persistence store.
 * @returns a fresh store handle for Slot registration.
 */
export function createBrowserStore(): EngineStoreHandle<BrowserState, BrowserActions> {
  return defineStore({
    init: (): BrowserState => ({ byTab: {} }),
    persist: 'dsh.sidebar-browser.v1',
    actions: {
      replace: (draft, surfaceId: BrowserSurfaceId, state: BrowserTabState) => { draft.byTab[surfaceId] = state },
      forget: (draft, surfaceId: BrowserSurfaceId) => {
        const byTab: BrowserState['byTab'] = {}
        for (const [id, state] of Object.entries(draft.byTab) as [BrowserSurfaceId, BrowserTabState][]) {
          if (id !== surfaceId) byTab[id] = state
        }
        draft.byTab = byTab
      },
    },
  })
}

/** Browser store handle shared by body and title registrations. */
export type BrowserStore = ReturnType<typeof createBrowserStore>
