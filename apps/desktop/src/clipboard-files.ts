/** Reading the file list a system clipboard holds, which only the main process can see. */
import { clipboard } from 'electron'
import { parseClipboardFileList } from './clipboard-file-list.ts'

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
