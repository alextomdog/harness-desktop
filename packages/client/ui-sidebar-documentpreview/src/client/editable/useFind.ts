/** Finding and replacing inside one document's text, as a hook over the editor's buffer. */
import { useCallback, useMemo, useState } from 'react'
import type { RefObject } from 'react'

/** What one document's find state and actions look like to its editor. */
export interface FindState {
  readonly query: string
  readonly replacement: string
  readonly replacing: boolean
  readonly open: boolean
  /** Which hit the reader is on, as an index into `hits`. */
  readonly at: number
  /** Every offset the query matches, in document order. */
  readonly hits: readonly number[]
  setQuery: (next: string) => void
  setReplacement: (next: string) => void
  openFind: (replacing: boolean) => void
  close: () => void
  /** Move to the next hit (or the previous one), keeping the textarea's own selection. */
  step: (delta: number) => void
  /** Replace the hit the reader is on. */
  replaceOne: () => void
  /** Replace every hit. */
  replaceAll: () => void
}

/**
 * Find and replace over one buffer.
 *
 * The editor owns the text, so the search lives beside it rather than in the bar: the bar renders
 * values, this decides them. Hits are case-insensitive offsets, which is what a reader comparing
 * two spellings of the same identifier expects, and the reader's position is an index into them so
 * that stepping wraps instead of stopping at an end they cannot see.
 * @param buffer - the document's current text.
 * @param setBuffer - write the text back, as an ordinary edit.
 * @param area - the textarea the hits are revealed in.
 * @param sync - bring the painted layer back in step after a programmatic change.
 * @returns find state and actions.
 */
export function useFind(
  buffer: string,
  setBuffer: (next: string) => void,
  area: RefObject<HTMLTextAreaElement | null>,
  sync: () => void,
): FindState {
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState(0)

  const hits = useMemo((): readonly number[] => {
    if (query === '') return []
    const haystack = buffer.toLowerCase()
    const needle = query.toLowerCase()
    if (needle === '') return []
    const found: number[] = []
    for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) {
      found.push(index)
    }
    return found
  }, [buffer, query])

  const reveal = useCallback((offset: number): void => {
    const element = area.current
    if (element === null) return
    element.focus()
    element.setSelectionRange(offset, offset + query.length)
    // Assigning a selection scrolls the browser itself; the painted layer follows only when it is
    // told, and a layer left behind draws its numbers against the wrong lines.
    sync()
  }, [area, query, sync])

  const step = useCallback((delta: number): void => {
    if (hits.length === 0) return
    const next = (at + delta + hits.length) % hits.length
    setAt(next)
    const offset = hits[next]
    if (offset !== undefined) reveal(offset)
  }, [at, hits, reveal])

  const replaceOne = useCallback((): void => {
    const offset = hits[at]
    if (offset === undefined) return
    setBuffer(buffer.slice(0, offset) + replacement + buffer.slice(offset + query.length))
    // The hits change with the text; keeping the index would step over a hit that moved.
    setAt(0)
  }, [at, buffer, hits, query.length, replacement, setBuffer])

  const replaceAll = useCallback((): void => {
    if (query === '') return
    let next = ''
    let cursor = 0
    for (const offset of hits) {
      next += buffer.slice(cursor, offset) + replacement
      cursor = offset + query.length
    }
    next += buffer.slice(cursor)
    setBuffer(next)
    setAt(0)
  }, [buffer, hits, query, replacement, setBuffer])

  return {
    query,
    replacement,
    replacing,
    open,
    at,
    hits,
    setQuery: (next) => { setQuery(next); setAt(0) },
    setReplacement,
    openFind: (alsoReplacing) => { setReplacing(alsoReplacing); setOpen(true) },
    close: () => { setOpen(false); setQuery('') },
    step,
    replaceOne,
    replaceAll,
  }
}
