/** Excel previews use ordinary authorized file bytes without Office conversion. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { Config } from '../../config.ts'
import { LazyExcelBody } from './LazyExcelBody.tsx'
import { createWriteBytes, type SessionFile } from '../rpc.ts'
import { en, zh } from './locales.ts'

/**
 * Register the browser Excel viewer and its lifecycle-owned slot.
 * @param ctx - Preview and locale registries.
 * @param limits - Resolved parser limits.
 */
export function apply(ctx: Context, limits: Config['excel']): void {
  const id = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/excel'
  ctx.effect(() => ctx.locale.register('sidebarExcel', { zh, en }))
  const t = ctx.locale.bind('sidebarExcel')
  ctx.effect(() => ctx.documentPreviews.register({
    id, extensions: ['xlsx', 'xls', 'csv', 'tsv'], binaryExtensions: ['xlsx', 'xls'], priority: 'builtin',
    // The delimited formats ARE text, so the reader edits the file itself and the
    // grid follows on reload. The workbooks are binary: the UTF-8 round trip in
    // the preview refuses them, so they stay read-only without a second rule here.
    title: () => t('title'), loading: 'bytes-complete', wrap: false, editable: true, editsSelf: true,
  }))
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document', key: id, locale: 'sidebarExcel',
    inject: () => ({
      limits,
      // One save per file, built from the address the tab carries: the same path
      // means different files in different sessions.
      save: (file: SessionFile, data: Uint8Array, expectedVersion: string, signal: AbortSignal) =>
        createWriteBytes(ctx.remote, file)(data, expectedVersion, signal),
    }),
  }, LazyExcelBody)))
}
