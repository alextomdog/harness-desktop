/**
 * The text type's chip title: the file type's coloured sheet before the name the
 * registry captured at open time, and — when the reader has edits the file does
 * not hold — the dot an editor shows for unsaved work.
 *
 * Registered under `sidebar.right.pane.tab.title` over the same store the body
 * writes, which is why the dot is here and not in the editor.
 */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { FileTypeIcon, classifyFileType } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TextStore } from './store.ts'
import css from './TextPreview.module.css'

/** The title's composed props: the tab reader, the store, and the dot's copy. */
export type TextTitleProps =
  & PropsRuntime<'sidebar.right.pane.tab.title'>
  & PropsStore<TextStore>
  & PropsLocale<'sidebarDocumentPreview'>

/**
 * The title as the chip and a floating panel's header show it.
 * @param props - the tab information hook, the tab store, and the dirty label.
 * @returns the type's 16px sheet, the tab's title, and the unsaved dot when there is one.
 */
export function TextTitle({ useTabInfo, useStore, t }: TextTitleProps): ReactNode {
  const { tab } = useTabInfo()
  const dirty = useStore(state => state.byTab[tab.id]?.dirty === true)
  return (
    <>
      <FileTypeIcon kind={classifyFileType(tab.title)} size={16} className={css.titleIcon} />
      {tab.title}
      {dirty && <span className={css.dirtyDot} role="img" aria-label={t('edit.dirty')} data-textpreview-dirty />}
    </>
  )
}
