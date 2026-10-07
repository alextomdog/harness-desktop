/**
 * Stage one of this package's registration: what the `files` tab type IS.
 *
 * The type is a page, not a viewer: it claims no address. The tree opens files
 * through `tabActions.openResource` for the `dsh-resource://file` viewers to
 * claim; the type offers no guide entry, because the guide's doors are the ones
 * that make something (a terminal, a browser), not a view of what is already
 * there.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type {} from './locales.ts'

/** The tab kind this package owns. */
export const FILES_KIND = 'files'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const FILES_ID = '@deepseek-ai/dsh-client-ui-sidebar-files'

/**
 * The files type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function filesDefinition(t: TranslateNS<'sidebarFiles'>): SidebarRightTabDefinition {
  return {
    id: FILES_ID,
    kind: FILES_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
  }
}
