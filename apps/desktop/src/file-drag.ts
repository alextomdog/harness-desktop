/** Window-owned native file drags started by the local Desktop renderer. */

import { isAbsolute } from 'node:path'
import { ipcMain, nativeImage, type BrowserWindow } from 'electron'
import { DESKTOP_IPC, assertDesktopSender } from './ipc.ts'

/**
 * A 1x1 transparent PNG. startDrag demands an icon and refuses an empty image, so this is the smallest
 * image that satisfies it rather than a decoration the reader would ever see.
 */
const DRAG_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * Install the application-lifetime file-drag IPC handler.
 *
 * A drag that carries a path is text: a drop target that wants a file — the page in the sidebar, or any
 * other application — gets the path written into it instead of the file. Starting a native drag from
 * here carries the real file, which is what an upload field accepts.
 * @param getWindow - Current local application window; shell pages and subframes cannot start a drag.
 */
export function installDesktopFileDrag(getWindow: () => BrowserWindow | undefined): void {
  ipcMain.handle(DESKTOP_IPC.fileDrag, (event, path: unknown) => {
    const window = getWindow()
    if (window === undefined || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('dsh desktop: rejected file drag from an unowned renderer')
    }
    assertDesktopSender(event, ['app'])
    if (typeof path !== 'string' || path === '' || !isAbsolute(path)) {
      throw new Error('dsh desktop: file drag needs an absolute path')
    }
    event.sender.startDrag({ file: path, icon: nativeImage.createFromDataURL(DRAG_ICON) })
    return true
  })
}
