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
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
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
const scopedStyles = `@scope ([data-excel-preview]) { ${fortuneCss} }`

/** How long editing rests before the workbook is written back. */
const SAVE_DEBOUNCE_MS = 900

/**
 * Display stored spreadsheet values and formats, and save the reader's edits back
 * into the file. Keep the mounted workbook sized to its preview pane.
 * @param props - Complete workbook bytes, limits, the save face, and locale.
 * @returns An isolated spreadsheet surface with cancellable loading.
 */
export function ExcelBody({ content, format, limits, t, loading, save, version, file }: LoadedExcelBodyProps): ReactNode {
  const data = content.kind === 'bytes' ? content.data : undefined
  const [state, setState] = useState<State>()
  const [attempt, setAttempt] = useState(0)
  const [draft, setDraft] = useState<readonly Sheet[] | undefined>(undefined)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [message, setMessage] = useState('')
  // Bumped to send a draft again after the reader keeps it across a refusal.
  const [revision, setRevision] = useState(0)
  // The drafts already written, so a re-parse of the same file does not save the
  // same grid twice.
  const writtenRef = useRef<readonly Sheet[] | undefined>(undefined)
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
  // Editing rests, then patches the file. A refusal stops here: sending again
  // would overwrite whatever won the race with a grid nobody chose.
  useEffect(() => {
    if (!writable || draft === undefined || data === undefined || parsed === undefined) return
    if (draft === writtenRef.current) return
    if (saveState === 'stale') return
    const timer = setTimeout(() => {
      setSaveState('saving')
      void applyEdits(data, parsed.sheets, draft).then(
        bytes => save(file, bytes, version, new AbortController().signal),
      ).then((outcome) => {
        if (outcome.kind === 'saved') {
          writtenRef.current = draft
          setSaveState('saved')
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
    }, SAVE_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [draft, revision, writable, data, parsed, save, file, version, saveState])
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
          : ''
  return <section className={css.body} data-excel-preview aria-label={t('title')}>
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
          writtenRef.current = undefined
          setSaveState('idle')
          setRevision(value => value + 1)
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
