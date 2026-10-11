// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { ElectronWebViewImpl } from '../src/client/electron/ElectronWebViewImpl.ts'
import { ElectronWebviewPresentation, type WebviewElement } from '../src/client/electron/ElectronWebviewPresentation.ts'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId } from '../src/types.ts'

it('clears a failed load when the main page retries without a toolbar command', async () => {
  let url = 'about:blank'
  let loading = true
  const element: WebviewElement = Object.assign(document.createElement('div'), {
    loadURL: vi.fn(async () => {}), getURL: () => url, getTitle: () => 'Recovered',
    canGoBack: () => false, canGoForward: () => false, clearHistory: vi.fn(),
    goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), isLoading: () => loading,
    setZoomFactor: vi.fn(async () => {}), getZoomFactor: () => 1, executeJavaScript: vi.fn(async () => undefined),
  })
  const bridge: DesktopBrowserBridge = {
    acquire: vi.fn(async () => ({ lease: 'lease' as DesktopBrowserLeaseId, partition: 'partition' })),
    release: vi.fn(async () => {}), onOpenRequested: () => () => {}, onNewPage: () => () => {},
  }
  const presentation = new ElectronWebviewPresentation({ mounted: () =>{  frame.attach() }, unmounted: () =>{  frame.detach() } })
  const frame = new ElectronWebViewImpl({ initial: undefined, persist: vi.fn(), openRequested: vi.fn() },
    bridge, async () => 'cwd:/workspace', presentation)
  const createElement = vi.spyOn(presentation, 'createElement').mockReturnValue(element)
  const host = document.createElement('div')
  host.id = 'electron-frame-retry'
  document.body.append(host)
  try {
    presentation.mount(host.id)
    frame.loadUrl({ kind: 'https', url: 'https://example.test/', title: 'Example' })
    await vi.waitFor(() => { expect(host.firstElementChild).toBe(element) })
    element.dispatchEvent(new Event('dom-ready'))
    element.dispatchEvent(Object.assign(new Event('did-fail-load'), {
      isMainFrame: true, errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED',
    }))
    expect(frame.getSnapshot().error?.code).toBe(-105)
    element.dispatchEvent(new Event('page-title-updated'))
    element.dispatchEvent(Object.assign(new Event('did-start-navigation'), { isMainFrame: false }))
    expect(frame.getSnapshot().error?.code).toBe(-105)

    element.dispatchEvent(Object.assign(new Event('did-start-navigation'), { isMainFrame: true }))
    expect(frame.getSnapshot()).toMatchObject({ error: undefined, loading: true })
    url = 'https://example.test/recovered'
    element.dispatchEvent(new Event('did-navigate'))
    loading = false
    element.dispatchEvent(new Event('did-stop-loading'))
    expect(frame.getSnapshot()).toMatchObject({ error: undefined, loading: false, target: { url, title: 'Recovered' } })
  } finally {
    await frame.dispose()
    createElement.mockRestore()
    host.remove()
  }
})

it('zooms the page on the step its guest reports for Ctrl+wheel', async () => {
  const loading = false
  const setZoomFactor = vi.fn(async (_factor: number) => {})
  const element: WebviewElement = Object.assign(document.createElement('div'), {
    loadURL: vi.fn(async () => {}), getURL: () => 'about:blank', getTitle: () => 'Zoom',
    canGoBack: () => false, canGoForward: () => false, clearHistory: vi.fn(),
    goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), isLoading: () => loading,
    setZoomFactor, getZoomFactor: () => 1, executeJavaScript: vi.fn(async () => undefined),
  })
  const bridge: DesktopBrowserBridge = {
    acquire: vi.fn(async () => ({ lease: 'lease' as DesktopBrowserLeaseId, partition: 'partition' })),
    release: vi.fn(async () => {}), onOpenRequested: () => () => {}, onNewPage: () => () => {},
  }
  const presentation = new ElectronWebviewPresentation({ mounted: () =>{  frame.attach() }, unmounted: () =>{  frame.detach() } })
  const frame = new ElectronWebViewImpl({ initial: undefined, persist: vi.fn(), openRequested: vi.fn() },
    bridge, async () => 'cwd:/workspace', presentation)
  vi.spyOn(presentation, 'createElement').mockReturnValue(element)
  const host = document.createElement('div')
  host.id = 'electron-frame-zoom'
  document.body.append(host)
  presentation.mount(host.id)
  frame.loadUrl({ kind: 'https', url: 'https://example.test/', title: 'Example' })
  await vi.waitFor(() => { expect(host.firstElementChild).toBe(element) })
  element.dispatchEvent(new Event('dom-ready'))
  // The gesture itself lives inside the guest; all this side sees is the step it reports.
  const report = (step: string): Event => Object.assign(new Event('console-message'), { message: 'dsh-sidebar-browser-zoom:' + step })
  element.dispatchEvent(report('1'))
  await vi.waitFor(() => { expect(setZoomFactor).toHaveBeenCalled() })
  const zoomIn = setZoomFactor.mock.calls.at(-1)?.[0] as number
  expect(zoomIn).toBeGreaterThan(1)
  // A console line that is not a zoom report must not move the zoom.
  element.dispatchEvent(Object.assign(new Event('console-message'), { message: 'hello' }))
  expect(setZoomFactor.mock.calls.length).toBe(1)
  element.dispatchEvent(report('-1'))
  const zoomOut = setZoomFactor.mock.calls.at(-1)?.[0] as number
  expect(zoomOut).toBeLessThan(zoomIn)
})

it('steps from the zoom the page reports rather than the last value written here', async () => {
  const setZoomFactor = vi.fn(async (_factor: number) => {})
  // The guest already carries a zoom this frame never set, as a restored page does.
  const element: WebviewElement = Object.assign(document.createElement('div'), {
    loadURL: vi.fn(async () => {}), getURL: () => 'about:blank', getTitle: () => 'Zoom',
    canGoBack: () => false, canGoForward: () => false, clearHistory: vi.fn(),
    goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), isLoading: () => false,
    setZoomFactor, getZoomFactor: () => 2, executeJavaScript: vi.fn(async () => undefined),
  })
  const bridge: DesktopBrowserBridge = {
    acquire: vi.fn(async () => ({ lease: 'lease' as DesktopBrowserLeaseId, partition: 'partition' })),
    release: vi.fn(async () => {}), onOpenRequested: () => () => {}, onNewPage: () => () => {},
  }
  const presentation = new ElectronWebviewPresentation({ mounted: () =>{  frame.attach() }, unmounted: () =>{  frame.detach() } })
  const frame = new ElectronWebViewImpl({ initial: undefined, persist: vi.fn(), openRequested: vi.fn() },
    bridge, async () => 'cwd:/workspace', presentation)
  vi.spyOn(presentation, 'createElement').mockReturnValue(element)
  const host = document.createElement('div')
  host.id = 'electron-frame-zoom-base'
  document.body.append(host)
  presentation.mount(host.id)
  frame.loadUrl({ kind: 'https', url: 'https://example.test/', title: 'Example' })
  await vi.waitFor(() => { expect(host.firstElementChild).toBe(element) })
  element.dispatchEvent(new Event('dom-ready'))
  element.dispatchEvent(Object.assign(new Event('console-message'), { message: 'dsh-sidebar-browser-zoom:-1' }))
  await vi.waitFor(() => { expect(setZoomFactor).toHaveBeenCalled() })
  // 2 / 1.1, not 1 / 1.1: the step is taken from what the page reports.
  expect(setZoomFactor.mock.calls.at(-1)?.[0] as number).toBeCloseTo(1.82, 1)
})

it('publishes the page zoom and keeps it inside the range a browser keeps', async () => {
  const element: WebviewElement = Object.assign(document.createElement('div'), {
    loadURL: vi.fn(async () => {}), getURL: () => 'about:blank', getTitle: () => 'Zoom',
    canGoBack: () => false, canGoForward: () => false, clearHistory: vi.fn(),
    goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), isLoading: () => false,
    setZoomFactor: vi.fn(async () => {}), getZoomFactor: () => 1, executeJavaScript: vi.fn(async () => undefined),
  })
  const bridge: DesktopBrowserBridge = {
    acquire: vi.fn(async () => ({ lease: 'lease' as DesktopBrowserLeaseId, partition: 'partition' })),
    release: vi.fn(async () => {}), onOpenRequested: () => () => {}, onNewPage: () => () => {},
  }
  const presentation = new ElectronWebviewPresentation({ mounted: () =>{  frame.attach() }, unmounted: () =>{  frame.detach() } })
  const frame = new ElectronWebViewImpl({ initial: undefined, persist: vi.fn(), openRequested: vi.fn() },
    bridge, async () => 'cwd:/workspace', presentation)
  vi.spyOn(presentation, 'createElement').mockReturnValue(element)
  const host = document.createElement('div')
  host.id = 'electron-frame-zoom-state'
  document.body.append(host)
  presentation.mount(host.id)
  frame.loadUrl({ kind: 'https', url: 'https://example.test/', title: 'Example' })
  await vi.waitFor(() => { expect(host.firstElementChild).toBe(element) })
  element.dispatchEvent(new Event('dom-ready'))
  expect(frame.getSnapshot().zoom).toBe(1)
  element.dispatchEvent(Object.assign(new Event('console-message'), { message: 'dsh-sidebar-browser-zoom:1' }))
  await vi.waitFor(() => { expect(frame.getSnapshot().zoom).toBeGreaterThan(1) })
  // The chrome reads this number, so it must be the clamped value the page actually carries.
  frame.zoom?.setZoom(99)
  expect(frame.getSnapshot().zoom).toBe(5)
  frame.zoom?.setZoom(0.01)
  expect(frame.getSnapshot().zoom).toBe(0.25)
  expect(element.setZoomFactor).toHaveBeenLastCalledWith(0.25)
})
