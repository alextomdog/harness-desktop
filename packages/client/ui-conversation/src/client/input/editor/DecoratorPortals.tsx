import { $getNodeByKey } from 'lexical'
/**
 * Decorator render loop: portals every decorator node's React face into its
 * host element (what @lexical/react's composer does internally, scoped to
 * this composer's needs). Chip DOM identity rides the NodeKey — text edits
 * around a chip never remount its portal.
 */
import * as React from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import type { LexicalEditor, NodeKey } from 'lexical'

/** Portal-loop props. */
export interface DecoratorPortalsProps {
  /** The bound editor; null (no-session) renders nothing. */
  readonly editor: LexicalEditor | null
}

/**
 * Render every decorator's React face into its editor host element.
 * @param props - the editor to observe.
 * @returns the live portal set.
 */
export function DecoratorPortals({ editor }: DecoratorPortalsProps): ReactNode {
  const [decorators, setDecorators] = React.useState<Record<NodeKey, React.JSX.Element>>(
    () => editor === null ? {} : editor.getDecorators<React.JSX.Element>(),
  )
  React.useLayoutEffect(() => {
    if (editor === null) return
    setDecorators(editor.getDecorators<React.JSX.Element>())
    return editor.registerDecoratorListener<React.JSX.Element>((next) => { setDecorators(next) })
  }, [editor])
  if (editor === null) return null
  return (
    <>
      {Object.entries(decorators).map(([key, jsx]) => {
        const el = editor.getElementByKey(key)
        if (el === null) return null
        // A chip cannot remove itself: a node has no editor to run an update through, and
        // `$getEditor` only means anything inside one. This loop has the editor, so it hands the
        // gesture down — and an ordinary update is what puts the removal on the undo stack,
        // beside every other edit the reader makes.
        return createPortal(
          React.cloneElement(jsx, {
            onRemove: () => { editor.update(() => { $getNodeByKey(key)?.remove() }) },
          }),
          el,
          key,
        )
      })}
    </>
  )
}
