/**
 * The shell's file-list format, parsed.
 *
 * Kept apart from the clipboard read that produces it: this needs no window, no Electron and no
 * clipboard, so it is the half worth testing on its own.
 */

/**
 * Split a shell file list into absolute paths.
 *
 * The format is the shell's own `FileNameW`: every path followed by a NUL, and the list closed by a
 * second NUL. Splitting on the NUL is therefore the whole of the parse — except that the trailing
 * empties it leaves are not paths, and a caller that received them would try to copy nothing.
 * @param raw - the decoded clipboard payload.
 * @returns the paths it names, in the order the shell wrote them.
 */
export function parseClipboardFileList(raw: string): readonly string[] {
  return raw
    .split('\u0000')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
}
