/**
 * The session and path an addressed workbook names, resolved inside this renderer.
 *
 * Deliberately not the tab body's helper: a value imported by two entry points
 * makes the bundler lift it into a chunk of its own, and this package's client
 * bundle is registered chunk by chunk — the runtime's module table carries the
 * entry and the chunks the build declares, not one it discovers at load time.
 * Resolving here keeps the excel renderer sharing no module with the tab body.
 */
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** The file one workbook tab addresses. */
export interface ExcelFile {
  /** The Session whose workspace resolves relative paths. */
  readonly sessionId: SessionId
  /** The path the Host receives, absolute or relative to that workspace. */
  readonly path: string
}

/**
 * @param address - a tab's `dsh-resource://file/…` address.
 * @returns the session and the path to hand the Host.
 * @throws when the address names no session file, which is a wiring error.
 */
export function excelFileOf(address: string): ExcelFile {
  const parsed = parseFileAddress(address)
  if (parsed?.scope !== 'session') throw new Error(`ui-sidebar-documentpreview: not a session file address "${address}"`)
  return { sessionId: parsed.sessionId as SessionId, path: parsed.path }
}
