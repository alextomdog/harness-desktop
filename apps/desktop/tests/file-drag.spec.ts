import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { DESKTOP_IPC } from '../src/ipc.ts'

const electron = vi.hoisted(() => ({
  handle: vi.fn<(channel: string, handler: (event: IpcMainInvokeEvent, path: unknown) => boolean) => void>(),
  createFromDataURL: vi.fn((url: string) => ({ url })),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: electron.handle },
  nativeImage: { createFromDataURL: electron.createFromDataURL },
}))
const { installDesktopFileDrag } = await import('../src/file-drag.ts')

beforeEach(() => { vi.resetAllMocks() })

function fixture() {
  const frame = { url: 'dsh-app://app/' }
  const startDrag = vi.fn()
  const window = {
    webContents: { mainFrame: frame, startDrag },
    isDestroyed: vi.fn(() => false),
  }
  let current: BrowserWindow | undefined = window as unknown as BrowserWindow
  installDesktopFileDrag(() => current)
  expect(electron.handle.mock.calls[0]?.[0]).toBe(DESKTOP_IPC.fileDrag)
  const handler = electron.handle.mock.calls[0]![1] as (event: IpcMainInvokeEvent, path: unknown) => boolean
  const event = { sender: window.webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  return { frame, event, handler, startDrag, detach: () => { current = undefined } }
}

describe('Desktop file drag', () => {
  it('starts a native drag that carries the real file', () => {
    const f = fixture()
    expect(f.handler(f.event, '/workspace/notes.md')).toBe(true)
    expect(f.startDrag).toHaveBeenCalledExactlyOnceWith({
      file: '/workspace/notes.md',
      icon: expect.anything(),
    })
    // startDrag refuses an empty image, so an icon is always built rather than left out.
    expect(electron.createFromDataURL).toHaveBeenCalledOnce()
  })

  it('refuses a relative path, an empty one, and a non-string', () => {
    const f = fixture()
    expect(() => f.handler(f.event, 'notes.md')).toThrow('absolute path')
    expect(() => f.handler(f.event, '')).toThrow('absolute path')
    expect(() => f.handler(f.event, 42)).toThrow('absolute path')
    expect(f.startDrag).not.toHaveBeenCalled()
  })

  it('rejects other windows, subframes, shell pages, remote pages, and missing windows', () => {
    const f = fixture()
    expect(() => f.handler({ ...f.event, sender: {} } as IpcMainInvokeEvent, '/workspace/a.md')).toThrow('unowned renderer')
    expect(() => f.handler({ ...f.event, senderFrame: {} } as IpcMainInvokeEvent, '/workspace/a.md')).toThrow('unowned renderer')
    for (const url of ['dsh-app://shell/startup.html', 'https://example.com/', 'http://127.0.0.1/']) {
      f.frame.url = url
      expect(() => f.handler(f.event, '/workspace/a.md')).toThrow('unowned renderer')
    }
    f.detach()
    expect(() => f.handler(f.event, '/workspace/a.md')).toThrow('unowned renderer')
    expect(f.startDrag).not.toHaveBeenCalled()
  })
})
