// @vitest-environment jsdom
/** Document extension registration and dispatch through the production Sidebar and Slot renderer. */
import { byteResult } from './fixtures.client.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { absoluteFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { apply as resourcesApply, inject as resourcesInject } from '@deepseek-ai/dsh-client-resources/src/client/index.ts'
import { apply as sidebarApply, inject as sidebarInject } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/index.ts'
import { apply, inject } from '../src/client/index.ts'
import type { DocumentPreviewProps } from '../src/client/document/contract.ts'
import type { DocumentLoadMode } from '../src/client/document/registry.ts'
import type { WorkspaceFilesReadRemote } from '../src/client/rpc.ts'
import { PLAIN_BODY_ID } from '../src/client/text/index.ts'

const SESSION = 'documents' as SessionId
const SHORTCUT_CATALOG: readonly never[] = []
let runtime: SlotTestRuntime | undefined
let animations: PropertyDescriptor | undefined

beforeEach(() => {
  animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
})

afterEach(async () => {
  try {
    await runtime?.dispose()
    runtime = undefined
  } finally {
    if (animations === undefined) Reflect.deleteProperty(Element.prototype, 'getAnimations')
    else Object.defineProperty(Element.prototype, 'getAnimations', animations)
  }
})

async function boot() {
  const rt = await SlotTestRuntime.create()
  runtime = rt
  rt.ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) } } as never)
  rt.ctx.provide('layout', { openRightbar: vi.fn(), closeRightbar: vi.fn(), panelInfo: rt.panelInfo } as never)
  rt.ctx.provide('shortcuts', { register: () => () => {}, catalog: { getSnapshot: () => SHORTCUT_CATALOG, subscribe: () => () => {} } } as never)
  const locale = new LocaleRuntime(rt.ctx)
  rt.ctx.provide('locale', locale)
  rt.slots.installLocale(locale)
  await rt.declare({
    rightbar: { kind: 'single', scope: 'root' },
    'conversation.session.header.corner': { kind: 'single', scope: 'session' },
  })
  await rt.sessions.add({ id: SESSION })
  await rt.sessions.retainFor(rt.ctx, SESSION, { source: 'mainView' }).ready
  await rt.mount({ inject: [...resourcesInject], apply: resourcesApply })
  const read = vi.fn<WorkspaceFilesReadRemote['workspaceFiles']['read']>().mockImplementation(async (_sessionId, _path, range) => ({
    ok: true,
    value: { absolutePath: '/host/notes', version: 'v1', bytes: 18, offset: range.offset ?? 1, text: range.offset === 3 ? 'third' : 'first\nsecond', lines: range.offset === 3 ? 1 : 2, eof: range.offset === 3 },
  }))
  const bytes = vi.fn(async () => byteResult(new TextEncoder().encode('all')))
  rt.remote.provideNamespaces({ workspaceFiles: { read, readBytes: bytes } })
  rt.ctx.effect(() => rt.ctx.resources.register({
    protocol: 'file',
    open: async function* (_address, { signal }) {
      if (!signal.aborted) yield { ok: true as const, value: { absolutePath: '/host/notes', version: 'v1', bytes: 18 } }
    },
  }))
  await rt.mount({ inject: [...sidebarInject], apply: sidebarApply })
  await rt.mount({ inject: [...inject], apply })
  const view = rt.renderSlot('rightbar', { width: 600, viewportWidth: 1440, canShow: true })
  const open = (name: string): void => {
    act(() => { rt.ctx.sidebarRight.openResource('dsh-resource://file/session/documents/' + name) })
  }
  const register = (id: string, loading: DocumentLoadMode, priority: 'builtin' | 'extension') => rt.ctx.effect(() => {
    const removeDefinition = rt.ctx.documentPreviews.register({ id, extensions: ['md'], priority, title: () => id, loading, wrap: loading === 'text-pages' })
    const removeBody = rt.slots.inject('sidebar.right.tab.document', () => rt.slots.register(
      { name: 'sidebar.right.tab.document', key: id },
      (props: DocumentPreviewProps) => {
        const { tab } = props.useTabInfo()
        const resource = props.useResource<'file'>(props.resourceAddress)
        expect(resource).not.toHaveProperty('operations')
        expect('ctx' in props).toBe(false)
        expect('useDocumentPreview' in props).toBe(false)
        return (
          <div
            data-renderer={id} data-renderer-tab={tab.id}
            data-renderer-path={resource.value?.absolutePath} data-renderer-version={resource.value?.version}
          >
            {props.content.kind === 'text' ? props.content.text : props.content.kind === 'bytes' ? new TextDecoder().decode(props.content.data) : 'renderer'}
          </div>
        )
      },
    ))
    return () => { removeBody(); removeDefinition() }
  })
  const showReader = async (container: HTMLElement): Promise<void> => {
    // Press it as soon as the document is drawn: it exists before the whole file
    // arrives, and pressing it then is what keeps the reader's own paging — the pages
    // the editor would otherwise read ahead — intact. A renderer that declares no
    // editor has no toggle, and is already a reader.
    // A document that can be edited opens in its editor, and what shows a rendered view
    // instead is CHOOSING that implementation from the picker — which is what these specs
    // do. One that declares no editor is already its reader, and there is nothing to press.
    // The wait matters: the editor appears only once the file is whole, and asking before
    // that would look exactly like a renderer that has no editor at all.
    const editor = await waitFor(
      () => container.querySelector('[data-textpreview-editor]'),
      { timeout: 2_000 },
    ).catch(() => null)
    if (editor === null) return
    const menu = await waitFor(() => {
      expect(container.querySelector('[data-document-viewer-menu]')).not.toBeNull()
      return container.querySelector<HTMLElement>('[data-document-viewer-menu]')
    })
    await act(async () => { fireEvent.click(menu as HTMLElement) })
    const items = await screen.findAllByRole('menuitem')
    // The editor is listed first, so the first implementation after it is the one the
    // registry's priority puts there.
    await act(async () => { fireEvent.click((items[1] ?? items[0]) as HTMLElement) })
  }
  return { rt, view, open, register, read, bytes, showReader }
}

describe('document extension seat', () => {
  it.each(['notes.unknown', '/other/notes.unknown', 'C:/other/notes.unknown', '//host/share/notes.unknown'])(
    'reads %s through its addressed Session rather than the mounted Tab Session',
    async (path) => {
      const h = await boot()
      act(() => { h.rt.ctx.sidebarRight.openResource(sessionFileAddress('address-session', path)) })
      // A small editable document opens in its editor and reads the whole file, so the
      // reader holds every line. What this case is about survives that: EVERY read —
      // the first page and the pages read ahead — goes through the file's own addressed
      // Session, never the Session the tab happens to be mounted under.
      await h.showReader(h.view.container)
      await waitFor(() => { expect(h.view.container.querySelectorAll('[data-textpreview-line]')).toHaveLength(3) })
      expect(h.read.mock.calls.map(([sessionId, callPath]) => [sessionId, callPath])).toEqual([
        ['address-session', path], ['address-session', path],
      ])
      expect(h.read.mock.calls[0]).toEqual(['address-session', path, { offset: 1 }, expect.any(AbortSignal)])
      expect(h.bytes).not.toHaveBeenCalled()
    },
  )

  it('rejects an unscoped absolute address through candidates before mounting a reader', async () => {
    const h = await boot()
    const address = absoluteFileAddress('/other/notes.unknown')
    expect(h.rt.ctx.sidebarRightTabs.candidates(address)).toEqual([])
    expect(() => {
      act(() => { h.rt.ctx.sidebarRight.openResource(address) })
    }).toThrow('no registered tab type claims')
    expect(() => {
      act(() => { h.rt.ctx.sidebarRight.openResource(address, { kind: 'text' }) })
    }).toThrow('tab type "text" refuses')
    expect(h.read).not.toHaveBeenCalled()
    expect(h.bytes).not.toHaveBeenCalled()
    expect(h.view.container.querySelector('[data-textpreview-state]')).toBeNull()
  })

  it('reads a small editable file whole, so the reader it opens beside holds every line', async () => {
    const h = await boot()
    h.open('notes.unknown')
    await h.showReader(h.view.container)
    // Two pages, both read before the reader is asked for anything: the editor holds the
    // whole file, and a reader over that file shows all of it.
    await waitFor(() => { expect(h.view.container.querySelectorAll('[data-textpreview-line]')).toHaveLength(3) })
    expect(h.view.container.querySelector('[data-document-preview]')?.getAttribute('data-document-preview')).toBe(PLAIN_BODY_ID)
    expect(h.read.mock.calls.map(([_sessionId, _path, range]) => range.offset)).toEqual([1, 3])
  })

  it('defaults to an extension, switches implementations without changing tabs, and restores a builtin on removal', async () => {
    const h = await boot()
    await act(async () => {
      h.register('builtin-reader', 'text-pages', 'builtin')
      h.register('extension-reader', 'bytes-complete', 'extension')
    })
    h.open('notes.md')
    await waitFor(() => {
      const body = h.view.container.querySelector('[data-renderer="extension-reader"]')
      expect(body?.textContent).toBe('all')
      expect(body?.getAttribute('data-renderer-path')).toBe('/host/notes')
      expect(body?.getAttribute('data-renderer-version')).toBe('v1')
    })
    const tab = h.view.container.querySelector('[data-renderer-tab]')?.getAttribute('data-renderer-tab')
    expect(h.read).not.toHaveBeenCalled()
    expect(h.bytes).toHaveBeenCalledOnce()
    fireEvent.click(h.view.container.querySelector('[data-document-viewer-menu]')!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'builtin-reader' }))
    await waitFor(() => { expect(h.view.container.querySelector('[data-renderer="builtin-reader"]')?.textContent).toBe('first\nsecond') })
    expect(h.view.container.querySelector('[data-renderer-tab]')?.getAttribute('data-renderer-tab')).toBe(tab)
    await act(async () => { h.register('later-reader', 'text-pages', 'extension') })
    expect(h.view.container.querySelector('[data-renderer="builtin-reader"]')).not.toBeNull()
  })

  it('returns to the matching builtin when the selected implementation is unregistered', async () => {
    const h = await boot()
    let remove: ReturnType<typeof h.register> | undefined
    await act(async () => {
      h.register('builtin-reader', 'text-pages', 'builtin')
      remove = h.register('extension-reader', 'text-pages', 'extension')
    })
    h.open('notes.md')
    await h.showReader(h.view.container)
    await waitFor(() => {
      expect(h.view.container.querySelector('[data-renderer="extension-reader"]')?.getAttribute('data-renderer-version')).toBe('v1')
    })
    await act(async () => { await remove!() })
    // The builtin that takes over is editable, so it opens in its editor: reading it is
    // the toolbar's toggle, exactly as for any other document.
    await h.showReader(h.view.container)
    await waitFor(() => { expect(h.view.container.querySelector('[data-document-markdown]')).not.toBeNull() })
    // One page through the extension reader, then the pages the editor reads ahead.
    expect(h.read.mock.calls.map(([_sessionId, _path, range]) => range.offset)).toEqual([1, 3])
  })
})
