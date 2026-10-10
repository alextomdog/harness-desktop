/** Reading the file list a system clipboard holds, which only the main process can see. */
import { clipboard } from 'electron'

/**
 * Split a shell file list into absolute paths.
 *
 * The format is the shell's own `FileNameW`: every path followed by a NUL, and the list closed by a
 * second NUL. Splitting on the NUL is therefore the whole of the parse — except that the trailing
 * empties it leaves are not paths, and a renderer that received them would try to copy nothing.
 *
 * Exported for its own sake: this is the part worth testing, and it needs no window to run.
 * @param raw - the decoded clipboard payload.
 * @returns the paths it names, in the order the shell wrote them.
 */
export function parseClipboardFileList(raw: string): readonly string[] {
  return raw
    .split('\u0000')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
}

/**
 * The clipboard face that can answer for a named format.
 *
 * Electron's `clipboard` reads a named format at runtime, and this version's types do not say so.
 * Narrowing here rather than casting the call site keeps the reason beside the one place that
 * depends on it.
 */
interface NamedClipboard {
  read(name: string): string
}

/**
 * Absolute paths of the files the system clipboard currently holds.
 *
 * Empty for a clipboard holding text or an image: a reader who copies a paragraph and pastes it at
 * a file tree is asking for something this cannot give them, and nothing is the honest answer.
 * @returns the paths, in clipboard order.
 */
export function readClipboardFilePaths(): readonly string[] {
  return parseClipboardFileList((clipboard as unknown as NamedClipboard).read('FileNameW'))
}
