/** The document editor's find bar, as a pure component over its own values. */
import type { ReactNode } from 'react'
import css from './FindBar.module.css'

/** Copy the bar draws; the editor's own labels seat passes these through. */
export interface FindBarLabels {
  readonly findAria: string
  readonly findPlaceholder: string
  readonly next: string
  readonly replaceAria: string
  readonly replacePlaceholder: string
  readonly replaceOne: string
  readonly replaceAll: string
  readonly close: string
}

/** Values and actions of one find bar. */
export interface FindBarProps {
  readonly query: string
  readonly replacement: string
  /** Whether the replace row is shown: Ctrl+F finds, Ctrl+R also replaces. */
  readonly replacing: boolean
  readonly labels: FindBarLabels
  readonly onQuery: (next: string) => void
  readonly onReplacement: (next: string) => void
  /** Move to the next hit; Enter in the query field does the same. */
  readonly onNext: () => void
  readonly onReplaceOne: () => void
  readonly onReplaceAll: () => void
  readonly onClose: () => void
}

/**
 * Render the find bar.
 *
 * A document being read is a text the reader searches, and the browser's own find cannot be
 * reached from a pane that keeps focus for editing. The bar therefore belongs to the editor, and
 * stays a pure component: it holds no state and searches nothing, so what it does is decided by
 * whoever owns the text.
 * @param props - the query, the replacement, and the actions.
 * @returns the bar element.
 */
export function FindBar({
  query, replacement, replacing, labels, onQuery, onReplacement, onNext, onReplaceOne, onReplaceAll, onClose,
}: FindBarProps): ReactNode {
  return (
    <div className={css.bar} data-textpreview-find>
      <input
        className={css.field}
        data-textpreview-find-input
        value={query}
        placeholder={labels.findPlaceholder}
        aria-label={labels.findAria}
        onChange={(event) => { onQuery(event.target.value) }}
        onKeyDown={(event) => {
          // Enter walks the hits, which is what a reader typing a query is about to do anyway.
          if (event.key !== 'Enter') return
          event.preventDefault()
          onNext()
        }}
      />
      <button type="button" className={css.action} data-textpreview-find-next onClick={onNext}>
        {labels.next}
      </button>
      {replacing && (
        <>
          <input
            className={css.field}
            data-textpreview-find-replacement
            value={replacement}
            placeholder={labels.replacePlaceholder}
            aria-label={labels.replaceAria}
            onChange={(event) => { onReplacement(event.target.value) }}
          />
          <button type="button" className={css.action} data-textpreview-find-replace onClick={onReplaceOne}>
            {labels.replaceOne}
          </button>
          <button type="button" className={css.action} data-textpreview-find-replace-all onClick={onReplaceAll}>
            {labels.replaceAll}
          </button>
        </>
      )}
      <button type="button" className={css.close} data-textpreview-find-close aria-label={labels.close} onClick={onClose}>
        ×
      </button>
    </div>
  )
}
