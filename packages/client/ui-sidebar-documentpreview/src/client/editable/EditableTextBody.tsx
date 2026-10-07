/**
 * The editor: one text file the reader owns while its tab is open.
 *
 * The buffer starts from the text the tab read and carries that read's version as
 * its basis, so a save can be REFUSED rather than overwrite a change the reader
 * never saw — the agent writing the same file, another window, another surface.
 * A refusal stops the timer and asks which side wins instead of guessing.
 *
 * Only a file whose content arrived whole is handed here at all: a save writes
 * the entire buffer, so a partially loaded one would truncate everything past
 * what was read. The caller enforces that; this component assumes it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { WriteWorkspaceFileOutcome } from '../rpc.ts'
import css from './EditableTextBody.module.css'

/** How long typing rests before a save is sent. */
const SAVE_DEBOUNCE_MS = 600

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
  readonly labels: EditableTextLabels
}

/**
 * @param props - the read text, its version, the save, the reload, and copy.
 * @returns the textarea, its save state, and the conflict's two choices.
 */
export function EditableTextBody({ text, version, save, reload, labels }: EditableTextBodyProps): ReactNode {
  const [buffer, setBuffer] = useState(text)
  const [state, setState] = useState<SaveState>('clean')
  const [message, setMessage] = useState('')
  // The textarea's own value is the truth for the timer, and the reader's
  // keystrokes must not be read through a stale render.
  const bufferRef = useRef(buffer)
  bufferRef.current = buffer
  const basisRef = useRef(version)
  const diskRef = useRef(text)
  // Set by "keep mine": the next text to arrive is the basis for a re-save rather
  // than a version to adopt.
  const resaveRef = useRef(false)

  // The Host's text is the truth about the file. A buffer the reader has NOT
  // touched follows it — the agent, another window, this reader elsewhere. A
  // touched buffer does not: those keystrokes outrank it, and the conflict line
  // is what asks which side wins.
  useEffect(() => {
    const untouched = bufferRef.current === diskRef.current
    diskRef.current = text
    basisRef.current = version
    if (untouched) {
      setBuffer(text)
      setState('clean')
      return
    }
    setState('stale')
  }, [text, version])

  const commit = useCallback((): void => {
    const content = bufferRef.current
    setState('saving')
    void save(content, basisRef.current, new AbortController().signal).then((outcome) => {
      if (outcome.kind === 'saved') {
        basisRef.current = outcome.version
        diskRef.current = content
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
  }, [save])

  // Typing rests, then saves. A conflict stops the timer: sending again would
  // overwrite whatever won the race with bytes the reader has not chosen yet.
  useEffect(() => {
    if (state === 'stale') return
    if (buffer === diskRef.current) return
    if (resaveRef.current) {
      // "Keep mine" asked the Host for the current version; the reader's text is
      // still in the buffer, so the basis is fresh and the save can land.
      resaveRef.current = false
      commit()
      return
    }
    const timer = setTimeout(commit, SAVE_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [buffer, version, commit, state])

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
      <p className={css.status} data-textpreview-save={state} hidden={line === ''}>
        <span className={css.statusText}>{line}</span>
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
              onClick={() => { setBuffer(diskRef.current); setState('clean'); reload() }}
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
        onChange={(event) => { setBuffer(event.target.value) }}
      />
    </div>
  )
}
