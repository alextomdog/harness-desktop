/** Load the spreadsheet renderer only when a supported workbook is opened. */
import { lazy, Suspense, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { excelFormat, type ExcelFormat } from './format.ts'
import type { ExcelLimits } from './model.ts'
import { excelFileOf } from './file-of.ts'
import type { SessionFile, WriteWorkspaceFileOutcome } from '../rpc.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'

/** Document input plus parser limits, the save face, and localized copy. */
export type ExcelBodyProps = DocumentPreviewProps & PropsLocale<'sidebarExcel'> & {
  readonly limits: ExcelLimits
  /**
   * Replace the workbook's bytes, guarded by the version it was read at.
   * @param file - session and path decoded from the tab address.
   * @param data - the workbook's complete new bytes.
   * @param expectedVersion - the version those bytes were read at.
   * @param signal - the save's own cancellation.
   * @returns what the save did, including the version it produced.
   */
  readonly save: (
    file: SessionFile, data: Uint8Array, expectedVersion: string, signal: AbortSignal,
  ) => Promise<WriteWorkspaceFileOutcome>
}

/** Lazily loaded renderer input with the parser choice, the resolved file, and main-bundle loading content. */
export type LoadedExcelBodyProps = ExcelBodyProps & {
  readonly format: ExcelFormat
  readonly loading: ReactNode
  /**
   * The resolved file, computed HERE rather than in the lazy renderer: a value
   * imported by both sides of a dynamic import becomes a chunk of its own, and
   * the runtime's `require` cannot answer a static cross-chunk request.
   */
  readonly file: SessionFile
}

const LoadedExcelBody = lazy(async () => ({ default: (await import('./excel.tsx')).ExcelBody }))

/**
 * Load the browser spreadsheet renderer for every registered format.
 * @param props - Complete file bytes and standard document seats.
 * @returns Localized loading state or Excel preview.
 */
export function LazyExcelBody(props: ExcelBodyProps): ReactNode {
  const file = excelFileOf(props.resourceAddress)
  const format = excelFormat(file.path)
  const loading = <LoadingIndicator label={props.t('loading')} />
  return <Suspense fallback={loading}>
    <LoadedExcelBody {...props} file={file} format={format} loading={loading} />
  </Suspense>
}
