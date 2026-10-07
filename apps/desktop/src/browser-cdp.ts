/**
 * The shell's half of the built-in browser bridge.
 *
 * The Host runs as a separate process and cannot see the sidebar's webview guests,
 * so an agent that wants to drive the browser the user is looking at has to ask
 * the shell. Requests arrive over the child's IPC channel, run against the lease's
 * guest through its DevTools Protocol debugger, and answer the same way control
 * requests already do — one request, one correlated reply.
 */
import type { DesktopBrowserGuests } from './browser-guests.ts'

/** One command the Host asks the shell to run against a browser guest. */
export interface DesktopBrowserCommandRequest {
  readonly type: 'browser-command'
  readonly requestId: number
  /** The lease the Host wants addressed, or absent to list the live pages. */
  readonly lease?: string
  /** A DevTools Protocol method name; absent with an absent lease means "list". */
  readonly method?: string
  readonly params?: Record<string, unknown>
}

/** Whether a message from the Host is a browser-bridge request. */
export function isDesktopBrowserCommandRequest(message: unknown): message is DesktopBrowserCommandRequest {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const candidate = message as Record<string, unknown>
  if (candidate.type !== 'browser-command') return false
  if (!Number.isSafeInteger(candidate.requestId)) return false
  if (candidate.lease !== undefined && typeof candidate.lease !== 'string') return false
  if (candidate.method !== undefined && typeof candidate.method !== 'string') return false
  if (candidate.params !== undefined
    && (typeof candidate.params !== 'object' || candidate.params === null || Array.isArray(candidate.params))) return false
  // A command needs both halves; a listing carries neither.
  return candidate.lease === undefined || candidate.method !== undefined
}

/**
 * Answer one browser-bridge request.
 *
 * A failure is reported as a reply rather than thrown: the Host is waiting on a
 * correlated id, and an unanswered request would hang the tool that asked.
 * @param guests - the shell's guest ownership.
 * @param request - the validated request.
 * @param send - the channel back to the Host.
 */
export async function answerBrowserCommand(
  guests: DesktopBrowserGuests,
  request: DesktopBrowserCommandRequest,
  send: (message: object) => void,
): Promise<void> {
  const reply = (payload: object): void => {
    send({ type: 'browser-command', requestId: request.requestId, ...payload })
  }
  try {
    if (request.lease === undefined) {
      reply({ pages: guests.list() })
      return
    }
    const result = await guests.command(request.lease, request.method ?? '', request.params)
    reply({ result: result ?? null })
  } catch (error: unknown) {
    reply({ error: error instanceof Error ? error.message : String(error) })
  }
}
