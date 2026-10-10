/**
 * The editor: one text file the reader owns while its tab is open.
 *
 * It is ONE surface, not two modes. The source is painted with the same highlighter the
 * read-only view uses, and the caret lives on top of it, so a reader types where they
 * read — there is no "edit mode" to enter and nothing to switch back to. Line numbers
 * run down a gutter beside the text, as they do in the view this replaces.
 *
 * The paint and the caret are two elements because a browser gives a real caret,
 * selection, undo and IME to a textarea and nothing else: the `pre` shows the tokens,
 * the transparent textarea owns the editing, and both are pinned to one set of font
 * metrics so the caret lands on the glyph it belongs to.
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
import {
  useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode,
} from 'react'
import { FindBar } from './FindBar.tsx'
import { useFind } from './useFind.ts'
import { useCodeHighlighter } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HighlightSpan } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WriteWorkspaceFileOutcome } from '../rpc.ts'
import css from './EditableTextBody.module.css'

/** What the editor is telling the reader about its last save. */
type SaveState = 'clean' | 'saving' | 'saved' | 'stale' | 'failed'

/** What one Tab inserts: four spaces, the width this project indents with. */
const INDENT = '    '

/** The find bar copy.
/**
 * TODO(locale): these belong in the editor's label seat beside the save strings, so a
 * translated build does not show Chinese here. Kept local for now so the feature is whole.
 */
const FIND_LABELS = {
  findAria: '查找',
  findPlaceholder: '查找…',
  next: '下一个',
  replaceAria: '替换为',
  replacePlaceholder: '替换为…',
  replaceOne: '替换',
  replaceAll: '全部替换',
  close: '关闭查找',
} as const

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
  /** Grammar to highlight with, from the file's path; absent falls back to plain text. */
  readonly language?: string
  /** Replace the file, guarded by the version the buffer was read at. */
  readonly save: (content: string, expectedVersion: string, signal: AbortSignal) => Promise<WriteWorkspaceFileOutcome>
  /** Ask the Host for the file again, after a refusal or an external write. */
  readonly reload: () => void
  /** Report whether unsaved edits remain, for the chip's dot. */
  readonly onDirty: (dirty: boolean) => void
  readonly labels: EditableTextLabels
  /** Whether a close was refused because this tab still holds unsaved edits. */
  readonly closePrompt?: boolean
  /** The close question's own words, translated by the caller. */
  readonly closeLabels?: {
    readonly message: string
    readonly save: string
    readonly discard: string
    readonly cancel: string
  }
  /** Ask the dock to close this tab; sent once a save the reader asked for has landed. */
  readonly onRequestClose?: () => void
  /** @param choice - the reader's answer about the unsaved edits. */
  readonly onResolveClose?: (choice: 'discard' | 'cancel') => void
}

/**
 * @param props - the read text, its version and grammar, the save, the reload, and copy.
 * @returns the highlighted editable surface, its save state, and the conflict's choices.
 */
export function EditableTextBody({
  text, version, language, save, reload, onDirty, labels, closePrompt, closeLabels, onResolveClose, onRequestClose,
}: EditableTextBodyProps): ReactNode {
  const [buffer, setBuffer] = useState(text)
  const [state, setState] = useState<SaveState>('clean')
  useEffect(() => {
    if (state !== 'saved' || !closeAfterSave.current) return
    closeAfterSave.current = false
    onRequestClose?.()
  }, [state, onRequestClose])
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
  // Set by "save and close": the save is the editor's own, and the tab goes only once that
  // save has actually landed, never on the strength of the click alone.
  const closeAfterSave = useRef(false)
  // Set by "keep mine": the next text to arrive is the basis for a re-save rather
  // than a version to adopt.
  const resaveRef = useRef(false)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const paintRef = useRef<HTMLPreElement | null>(null)
  const gutterRef = useRef<HTMLDivElement | null>(null)
  // The shared lazy highlighter, bound to this file's grammar: it returns undefined while
  // a lazily imported grammar is still on its way, and re-renders by itself when it lands.
  const highlight = useCodeHighlighter(language)

  // The Host's text is the truth about the file. A buffer the reader has NOT
  // touched follows it — the agent, another window, this reader elsewhere. A
  // touched buffer does not: those keystrokes outrank it, and the conflict line
  // is what asks which side wins.
  useEffect(() => {
    const untouched = bufferRef.current === savedText
    basisRef.current = version
    if (untouched) {
      // Assigning a controlled textarea's value resets its scroll to the top. A reader who pressed
      // Ctrl+S — or whose file changed elsewhere — is somewhere in the middle of a document, and
      // being thrown back to its first line costs them their place every single time. The offset is
      // carried across the update, and the painted layer is synced with it because a programmatic
      // assignment does not raise the scroll event that normally keeps the two together.
      const area = areaRef.current
      const keep = area === null ? 0 : area.scrollTop
      setBuffer(text)
      setSavedText(text)
      setState(current => (current === 'stale' ? 'clean' : current))
      if (area !== null) {
        requestAnimationFrame(() => {
          area.scrollTop = keep
          syncLayers()
        })
      }
      return
    }
    setState('stale')
  }, [text, version, savedText])

  // The dot follows the buffer, not the clock: any difference from what the file
  // holds is unsaved work, and a save clears it.
  useEffect(() => {
    onDirty(buffer !== savedText)
  }, [buffer, savedText, onDirty])

  const lines = useMemo(() => buffer.split('\n'), [buffer])
  const spans = useMemo((): readonly (readonly HighlightSpan[])[] => {
    const highlighted = highlight(buffer)
    return highlighted ?? lines.map(line => [{ text: line, style: {} }])
  }, [buffer, highlight, lines])

  /**
   * Follow the caret's line, the way an editor marks where the reader is working.
   *
   * The line is counted from the caret offset rather than measured: the buffer is the same
   * text the paint draws, so the count is exact and costs nothing per keystroke.
   */
  const [caretLine, setCaretLine] = useState(0)
  const syncCaret = useCallback((): void => {
    const area = areaRef.current
    if (area === null) return
    const upto = area.value.slice(0, area.selectionStart)
    let line = 0
    for (let at = upto.indexOf('\n'); at !== -1; at = upto.indexOf('\n', at + 1)) line += 1
    setCaretLine(line)
  }, [])

  /**
   * Keep the paint and the gutter where the caret layer is.
   *
   * A textarea is the only scroller of the three, so the other two follow it — after a
   * scroll, and after every render, because a keystroke can change the line count under
   * the caret without any scroll happening at all.
   */
  const syncLayers = useCallback((): void => {
    const area = areaRef.current
    if (area === null) return
    if (paintRef.current !== null) {
      paintRef.current.scrollTop = area.scrollTop
      paintRef.current.scrollLeft = area.scrollLeft
    }
    if (gutterRef.current !== null) gutterRef.current.scrollTop = area.scrollTop
  }, [])
  useEffect(syncLayers)

  // Finding is the editor's own business: the text is here, and so is the textarea the hits are
  // revealed in.
  const find = useFind(buffer, setBuffer, areaRef, syncLayers)

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
    if (event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      commit()
      return
    }
    // Ctrl+F and Ctrl+R belong to the TEXT, like Tab: focus leaving the document on a keystroke the
    // reader aimed at its content is the mistake an editor must not make.
    if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'f' || event.key.toLowerCase() === 'r')) {
      event.preventDefault()
      find.openFind(event.key.toLowerCase() === 'r')
      return
    }
    if (event.key === 'Escape' && find.open) {
      event.preventDefault()
      find.close()
      return
    }
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return
    // Tab belongs to the TEXT here, not to focus. Leaving the document on a keystroke the
    // reader aimed at their indentation is the one thing an editor must not do — and it
    // is what a plain textarea does by default.
    event.preventDefault()
    const area = event.currentTarget
    const { selectionStart, selectionEnd, value } = area
    setBuffer(`${value.slice(0, selectionStart)}${INDENT}${value.slice(selectionEnd)}`)
    const caret = selectionStart + INDENT.length
    // The value lands on the next render, so the caret is placed after it.
    requestAnimationFrame(() => { area.setSelectionRange(caret, caret) })
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
      {find.open && (
        <FindBar
          query={find.query}
          replacement={find.replacement}
          replacing={find.replacing}
          labels={FIND_LABELS}
          onQuery={find.setQuery}
          onReplacement={find.setReplacement}
          onNext={() => { find.step(1) }}
          onReplaceOne={find.replaceOne}
          onReplaceAll={find.replaceAll}
          onClose={find.close}
        />
      )}
      {/* The dock refused the close; this is why, and the two things the reader can do about
          it. Saving is the editor's own Ctrl+S path — the one the whole tab already trusts —
          so the prompt does not grow a second way to write the file. */}
      {closePrompt === true && closeLabels !== undefined && (
        <div className={css.closePrompt} role="status" data-textpreview-close-prompt>
          <span>{closeLabels.message}</span>
          <button
            type="button"
            data-textpreview-close-save
            onClick={() => { closeAfterSave.current = true; commit() }}
          >{closeLabels.save}</button>
          <button
            type="button"
            data-textpreview-close-discard
            onClick={() => { onDirty(false); onResolveClose?.('discard') }}
          >{closeLabels.discard}</button>
          <button
            type="button"
            data-textpreview-close-cancel
            onClick={() => { onResolveClose?.('cancel') }}
          >{closeLabels.cancel}</button>
        </div>
      )}
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
      <div className={css.surface}>
        <div className={css.stack}>
          <pre ref={paintRef} className={css.highlight} aria-hidden data-textpreview-highlight>
            {spans.map((lineSpans, index) => (
              <div
                className={css.highlightLine}
                key={index}
                {...index === caretLine ? { 'data-textpreview-active-line': '' } : {}}
              >
                {/* The number lives INSIDE its line, so a line that wraps keeps one number
                    on its first row and the wrapped rows stay indented under the text —
                    which is what an editor does, and what a separate column cannot do. */}
                <span
                  className={css.lineNumber}
                  aria-hidden
                  data-textpreview-line-number
                  {...index === caretLine ? { 'data-textpreview-active-line-number': '' } : {}}
                >
                  {index + 1}
                </span>
                {lineSpans.length === 0 || lineSpans.every(span => span.text === '')
                  // An empty line still needs a line box, or the paint drifts above the caret.
                  ? <br />
                  : lineSpans.map((span, at) => <span key={at} style={span.style}>{span.text}</span>)}
              </div>
            ))}
          </pre>
          <textarea
            ref={areaRef}
            className={css.area}
            value={buffer}
            spellCheck={false}
            aria-label={labels.editAria}
            data-textpreview-textarea
            onKeyDown={onKeyDown}
            onScroll={syncLayers}
            // A caret can move without a keystroke — a click, an arrow, a select-all — so
            // the mark follows every path the browser reports, not only typing.
            onSelect={syncCaret}
            onKeyUp={syncCaret}
            onClick={syncCaret}
            onFocus={syncCaret}
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
      </div>
    </div>
  )
}
