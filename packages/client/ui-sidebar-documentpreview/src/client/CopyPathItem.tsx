/** One tab's menu contribution: copy the file this tab is showing. */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import css from './CopyPathItem.module.css'

/**
 * Render the copy-path item for a tab that shows a file.
 *
 * Contributed through the tab menu slot rather than added to the kit's own menu: the kit is generic
 * and has no idea what a tab shows, while this plugin is the one that knows a document tab is a
 * file and where that file lives. A tab of any other kind renders nothing, so the item never
 * appears where it would mean nothing.
 * @param props - the menu owner share (tab and dismiss).
 * @returns the menu item, or null for a tab that is not a file.
 */
export function CopyPathItem({ tab, dismiss }: PropsRuntime<'sidebar.right.tab.menu.item'>): ReactNode {
  const parsed = parseFileAddress(tab.contentId)
  if (parsed === undefined) return null
  return (
    <button
      type="button"
      role="menuitem"
      data-sidebar-copy-path
      className={css.item}
      onClick={(event) => {
        event.stopPropagation()
        dismiss()
        void navigator.clipboard.writeText(parsed.path)
      }}
    >
      复制文件路径
    </button>
  )
}
