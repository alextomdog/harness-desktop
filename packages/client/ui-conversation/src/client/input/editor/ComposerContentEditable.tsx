/**
 * The composer's contenteditable host: binds one shell-owned Lexical editor
 * to a resident div. Session-maybe by design — a null editor renders the
 * same DOM inert (the no-session Workspace-trigger state), so switching
 * between the two never swaps the element tree. Editability has ONE writer:
 * this component reflects the `editable` prop onto the editor; nothing else
 * calls setEditable.
 */
import { useLayoutEffect, useRef } from 'react'
import type { DragEvent, HTMLAttributes, ReactNode } from 'react'
import type { LexicalEditor } from 'lexical'

/** Host props: the editor binding plus the div passthroughs the bar owns. */
export interface ComposerContentEditableProps extends HTMLAttributes<HTMLDivElement> {
  /** The shell-owned editor; null renders the same div unbound and inert. */
  readonly editor: LexicalEditor | null
  /** Whether the user may edit (readOnly/disabled states fold in here). */
  readonly editable: boolean
  /**
   * Paths dropped onto the composer, in the order they arrived.
   *
   * Absent means this host does not accept drops, and then it does not claim them either: a
   * drag over a composer nobody wired is left to the browser, not silently swallowed.
   */
  readonly onDropPaths?: (paths: readonly string[]) => void
}

/** The plain-text payload a dropped path travels in. */
const PATH_MIME = 'text/plain'

/**
 * Paths carried by one drag.
 *
 * Only paths: a drag from the file tree is the case this exists for, and it carries the
 * location rather than the bytes. A file dragged in from outside the application therefore
 * does not arrive as a path here and is left alone rather than guessed at.
 * @param transfer - the drag's data transfer.
 * @returns the paths it carried, empty when it carried none.
 */
function droppedPaths(transfer: DataTransfer | null): readonly string[] {
  if (transfer === null) return []
  const text = transfer.getData(PATH_MIME)
  if (text === '') return []
  return text.split('\n').map(line => line.trim()).filter(line => line !== '')
}

/**
 * Render the composer's editable surface.
 * @param props - editor binding, editability, and div passthroughs.
 * @returns the resident contenteditable div.
 */
export function ComposerContentEditable({ editor, editable, onDropPaths, ...rest }: ComposerContentEditableProps): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null)
  // Claim the drag only while it is over a composer that will do something with it: claiming
  // one nobody wired would swallow a drop that belongs to the page behind it.
  const dropHandlers = onDropPaths === undefined ? {} : {
    onDragOver: (event: DragEvent<HTMLDivElement>): void => {
      if (event.dataTransfer === null) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    onDrop: (event: DragEvent<HTMLDivElement>): void => {
      const paths = droppedPaths(event.dataTransfer)
      if (paths.length === 0) return
      event.preventDefault()
      onDropPaths(paths)
    },
  }
  useLayoutEffect(() => {
    const el = ref.current
    if (editor === null || el === null) return
    editor.setRootElement(el)
    return () => { editor.setRootElement(null) }
  }, [editor])
  useLayoutEffect(() => {
    if (editor !== null) editor.setEditable(editable)
  }, [editor, editable])
  return (
    <div
      ref={ref}
      // Lexical's setRootElement never touches contenteditable; the binding
      // renders it, and setEditable above keeps the editor's own gate in step.
      contentEditable={editor !== null && editable}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      data-composer-input
      {...dropHandlers}
      {...rest}
    />
  )
}
