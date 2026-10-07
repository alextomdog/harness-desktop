/**
 * The editor: one text file the reader owns while its tab is open.
 *
 * Saving is the READER's, not the clock's. Typing marks the tab dirty — the chip
 * grows the dot an editor shows — and Ctrl+S (or Cmd+S) writes the buffer under
 * the version the tab read. Nothing is written until then, so a file being edited
 * is never half-saved behind the reader's back.
 *
 * A file written underneath the reader in the meantime is REFUSED rather than
 * overwritten: their words stay on screen and the two sides are offered, because
 * an editor that guesses would silently discard one of them.
 *
 * Only a file whose content arrived whole is handed here at all: a save writes the
 * entire buffer, so a partially loaded one would truncate everything past what was
 * read. The caller enforces that; this component assumes it.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { WriteWorkspaceFileOutcome } from '../rpc.ts'
import css from './EditableTextBody.module.css'

/** What the editor is telling the reader about its last save. */
type SaveState = 'clean' | 'saving' | 'saved' | 'stale' | 'failed'

/** Copy the editor shows. */
export interface EditableTextLabels {
  readonly saving: string
  readonly saved: string
  readonly stale: string
  readonly keepMine: string
  readonly useDisk: string
  readonly failed: string
  /** The textarea's accessible name. */
  readonly editAria: string
  /** The hint that names the save key. */
  readonly saveHint: string
}

export interface EditableTextBodyProps {
  /** The text the tab read; adopted whenever the reader has not touched it. */
  readonly text: string
  /** The version `text` came from. */
  readonly version: string
  /** Replace the file, guarded by the version the buffer was read at. */
  readonly save: (content: string, expectedVersion: string, signal: AbortSignal) => Promise<WriteWorkspaceFileOutcome>
  /** Ask the Host for the file again, after a refusal or an external write. */
  readonly reload: () => void
  /** Report whether unsaved edits remain, for the chip's dot. */
  readonly onDirty: (dirty: boolean) => void
  readonly labels: EditableTextLabels
}

/**
 * @param props - the read text, its version, the save, the reload, and copy.
 * @returns the textarea, its save state, and the conflict's two choices.
 */
export function EditableTextBody({ text, version, save, reload, onDirty, labels }: EditableTextBodyProps): ReactNode {
  const [buffer, setBuffer] = useState(text)
  const [state, setState] = useState<SaveState>('clean')
  const [message, setMessage] = useState('')
  // What the FILE holds, as far as this editor knows: the text it was read from,
  // then whatever a save wrote. The dot is the buffer's difference from it, which
  // is why the two live together.
  const [savedText, setSavedText] = useState(text)
  // The textarea's own value is the truth for a save, and the reader's keystrokes
  // must not be read through a stale render.
  const bufferRef = useRef(buffer)
  bufferRef.current = buffer
  const basisRef = useRef(version)
  // Set by "keep mine": the next text to arrive is the basis for a re-save rather
  // than a version to adopt.
  const resaveRef = useRef(false)

  // The Host's text is the truth about the file. A buffer the reader has NOT
  // touched follows it — the agent, another window, this reader elsewhere. A
  // touched buffer does not: those keystrokes outrank it, and the conflict line
  // is what asks which side wins.
  useEffect(() => {
    const untouched = bufferRef.current === savedText
    basisRef.current = version
    if (untouched) {
      setBuffer(text)
      setSavedText(text)
      setState(current => (current === 'stale' ? 'clean' : current))
      return
    }
    setState('stale')
  }, [text, version, savedText])

  // The dot follows the buffer, not the clock: any difference from what the file
  // holds is unsaved work, and a save clears it.
  useEffect(() => {
    onDirty(buffer !== savedText)
  }, [buffer, savedText, onDirty])

  const commit = useCallback((): void => {
    const content = bufferRef.current
    if (content === savedText) {
      // Nothing to write: Ctrl+S on a clean buffer is not an error.
      setState('saved')
      return
    }
    setState('saving')
    void save(content, basisRef.current, new AbortController().signal).then((outcome) => {
      if (outcome.kind === 'saved') {
        basisRef.current = outcome.version
        setSavedText(content)
        setState('saved')
        return
      }
      if (outcome.kind === 'stale') {
        setState('stale')
        return
      }
      setMessage(outcome.message)
      setState('failed')
    })
  }, [save, savedText])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // The editor's save key, wherever the caret is: the reader should not have to
    // leave the text to keep it.
    if (event.key.toLowerCase() !== 's' || !(event.ctrlKey || event.metaKey)) return
    event.preventDefault()
    commit()
  }, [commit])

  const line = state === 'saving'
    ? labels.saving
    : state === 'saved'
      ? labels.saved
      : state === 'stale'
        ? labels.stale
        : state === 'failed'
          ? `${labels.failed} ${message}`
          : ''
  return (
    <div className={css.editor} data-textpreview-editor>
      <p className={css.status} data-textpreview-save={state} hidden={line === '' && state !== 'clean'}>
        <span className={css.statusText}>{line === '' ? labels.saveHint : line}</span>
        {state === 'stale' && (
          <>
            <button
              type="button"
              className={css.action}
              data-textpreview-keep-mine
              onClick={() => { resaveRef.current = true; reload() }}
            >
              {labels.keepMine}
            </button>
            <button
              type="button"
              className={css.action}
              data-textpreview-use-disk
              onClick={() => { setBuffer(text); setSavedText(text); setState('clean'); reload() }}
            >
              {labels.useDisk}
            </button>
          </>
        )}
      </p>
      <textarea
        className={css.area}
        value={buffer}
        spellCheck={false}
        aria-label={labels.editAria}
        data-textpreview-textarea
        onKeyDown={onKeyDown}
        onChange={(event) => {
          const next = event.target.value
          // "Keep mine" asked for the current version; the reader's next keystroke
          // lands on that basis, so the pending re-save is no longer needed.
          if (resaveRef.current) resaveRef.current = false
          setBuffer(next)
        }}
        onBlur={() => {
          if (!resaveRef.current) return
          resaveRef.current = false
          commit()
        }}
      />
    </div>
  )
}
