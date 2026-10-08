/**
 * Editable spreadsheet surface backed by browser-parsed workbook data.
 *
 * The grid edits in place, and a save patches the FILE rather than serializing
 * the grid: `applyEdits` loads the original bytes and writes back only the cells
 * that changed, so styles, merges, column widths, and the sheets the reader never
 * opened survive. Every save carries the version the bytes were read at, so a
 * workbook written underneath the reader is refused instead of clobbered.
 *
 * Editing is offered only where a save can be honest. The format needs a writer
 * (`.xlsx`; the legacy `.xls` reader has none), the read needs a version to guard
 * on, and the workbook must hold nothing the writer would DROP — a chart that
 * vanished on save would be worse than a grid that cannot save at all. When any
 * of that fails the grid stays read-only and says why.
 *
 * Saving is the READER's, not the clock's: a cell edit marks the tab dirty and
 * `Ctrl+S` writes it back, exactly as it does for a text document. An autosave would
 * make the file and the grid agree without anyone having decided they should.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Workbook } from '@fortune-sheet/react'
import type { Sheet } from '@fortune-sheet/core'
import { Button, IconWarningTriangleOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import fortuneCss from '@fortune-sheet/react/dist/index.css?inline'
import type { ExcelFormat } from './format.ts'
import type { ExcelPreview } from './model.ts'
import type { LoadedExcelBodyProps } from './LazyExcelBody.tsx'
import { parseExcel } from './parse.ts'
import { applyEdits } from './writeback.ts'
import css from './ExcelBody.module.css'

type State = { data: Uint8Array<ArrayBuffer>; format: ExcelFormat } & ({ value: ExcelPreview } | { error: string })
type SaveState = 'idle' | 'saving' | 'saved' | 'stale' | 'failed'
/** The reader's edits against the last grid written, or against the file itself. */
const scopedStyles = `@scope ([data-excel-preview]) { ${fortuneCss} }`

/**
 * Display stored spreadsheet values and formats, and save the reader's edits back
 * into the file. Keep the mounted workbook sized to its preview pane.
 * @param props - Complete workbook bytes, limits, the save face, and locale.
 * @returns An isolated spreadsheet surface with cancellable loading.
 */
export function ExcelBody({ content, format, limits, t, loading, save, version, file, onDirty }: LoadedExcelBodyProps): ReactNode {
  const data = content.kind === 'bytes' ? content.data : undefined
  const [state, setState] = useState<State>()
  const [attempt, setAttempt] = useState(0)
  const [draft, setDraft] = useState<readonly Sheet[] | undefined>(undefined)
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [message, setMessage] = useState('')
  // The grid reports its own load through `onChange`, so the first draft it hands over
  // IS the file: it becomes the baseline the reader's edits are measured against.
  // Without that every workbook would open already dirty — and, before saving became
  // the reader's, already written back on open.
  const baselineRef = useRef<readonly Sheet[] | undefined>(undefined)
  const workbookRef = useRef<HTMLDivElement>(null)
  const parsed = state !== undefined && !('error' in state) ? state.value : undefined
  // A writer for this format, a version to guard on, and nothing the writer drops.
  const writable = format === 'xlsx' && version !== undefined && parsed !== undefined
    && parsed.unsupportedFeatures.length === 0
  useEffect(() => {
    if (data === undefined) return
    const controller = new AbortController()
    setState(undefined)
    void parseExcel(data, format, limits, controller.signal).then(
      (value) => { if (!controller.signal.aborted) setState({ data, format, value }) },
      (error: unknown) => { if (!controller.signal.aborted) setState({ data, format, error: error instanceof Error ? error.message : 'invalid' }) },
    )
    return () => { controller.abort() }
  }, [data, format, limits, attempt])
  useEffect(() => {
    const element = workbookRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    // FortuneSheet measures its canvas on window resize, but pane resizing does not emit that event.
    const observer = new ResizeObserver(() => { window.dispatchEvent(new Event('resize')) })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [state])
  // The grid's edits are the reader's until `Ctrl+S`, so the tab's dot follows them and
  // the save hint stands where the save state will report itself.
  useEffect(() => {
    if (draft === undefined) {
      baselineRef.current = undefined
      setDirty(false)
      onDirty?.(false)
      return
    }
    baselineRef.current ??= draft
    const next = draft !== baselineRef.current
    setDirty(next)
    onDirty?.(next)
  }, [draft, onDirty])
  /**
   * Write the grid back into the file.
   *
   * A refusal stops here rather than retrying: sending again would overwrite whatever
   * won the race with a grid nobody chose.
   */
  const commit = useCallback((force = false): void => {
    if (!writable || draft === undefined || data === undefined || parsed === undefined) return
    if (!force && (draft === baselineRef.current || saveState === 'stale')) return
    setSaveState('saving')
    void applyEdits(data, parsed.sheets, draft).then(
      bytes => save(file, bytes, version, new AbortController().signal),
    ).then((outcome) => {
      if (outcome.kind === 'saved') {
        baselineRef.current = draft
        setSaveState('saved')
        setDirty(false)
        onDirty?.(false)
        return
      }
      if (outcome.kind === 'stale') {
        setSaveState('stale')
        return
      }
      setMessage(outcome.message)
      setSaveState('failed')
    }, (error: unknown) => {
      setMessage(error instanceof Error ? error.message : String(error))
      setSaveState('failed')
    })
  }, [writable, draft, data, parsed, save, file, version, saveState, onDirty])
  if (data === undefined) return <p className={css.status} role="alert">{t('invalid')}</p>
  if (state?.data !== data || state.format !== format) return loading
  if ('error' in state) return <div className={css.status} role="alert">
    <span>{t(state.error === 'tooLarge' || state.error === 'timeout' || state.error === 'encoding' ? state.error : 'invalid')}</span>
    <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button>
  </div>
  const unsupported = state.value.unsupportedFeatures
  const hasFormulas = state.value.sheets.some(sheet => sheet.celldata?.some(cell => cell.v?.f !== undefined))
  const line = saveState === 'saving'
    ? t('saving')
    : saveState === 'saved'
      ? t('saved')
      : saveState === 'stale'
        ? t('saveStale')
        : saveState === 'failed'
          ? `${t('saveFailed')} ${message}`
          : dirty ? t('saveHint') : ''
  return <section
    className={css.body}
    data-excel-preview
    aria-label={t('title')}
    onKeyDown={(event) => {
      // The grid owns focus, so the shortcut is caught here, above it. The same keys a
      // text document answers to, because it is the same promise: nothing is written
      // until the reader says so.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        commit()
      }
    }}
  >
    <style>{scopedStyles}</style>
    {unsupported.length > 0 && <div className={css.notice} role="note" data-excel-unsupported-notice>
      <IconWarningTriangleOutlineRegular size={16} />
      <span>{t(format === 'xlsx' ? 'unsupportedReadOnly' : 'unsupportedNotice', {
        features: unsupported.map(feature => t(feature)).join(t('featureSeparator')),
      })}</span>
    </div>}
    {line !== '' && <p className={css.notice} role="status" data-excel-save={saveState}>
      <span>{line}</span>
      {saveState === 'stale' && <>
        <Button size="sm" onClick={() => {
          // Keep the reader's grid and send it again: the file has moved, so the
          // tab has re-read it and `version` is the fresh basis.
          baselineRef.current = undefined
          setSaveState('idle')
          commit(true)
        }}>{t('saveKeepMine')}</Button>
        <Button size="sm" onClick={() => { setDraft(undefined); setSaveState('idle') }}>{t('saveDiscard')}</Button>
      </>}
    </p>}
    <div ref={workbookRef} className={`${css.workbook} ${hasFormulas ? css.withFormulaWarning : ''}`}>
      {hasFormulas && <Tooltip portal label={t('formulaWarning')} side="bottom" delayMs={500}>
        <button type="button" className={css.formulaWarning} aria-label={t('formulaWarning')} data-excel-formula-warning>
          <IconWarningTriangleOutlineRegular size={14} />
        </button>
      </Tooltip>}
      <Workbook key={`${attempt}:${t('language')}`} data={state.value.sheets} lang={t('language')}
        allowEdit={writable} showToolbar={false} showFormulaBar showSheetTabs forceCalculation={false}
        onChange={(next) => { setDraft(next) }}
        cellContextMenu={writable ? ['copy', 'paste', 'clear'] : ['copy']}
        headerContextMenu={[]} sheetTabContextMenu={[]} filterContextMenu={[]} />
    </div>
  </section>
}
