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
  /** Event-log read: the last sequence the Host already saw. */
  readonly eventsSince?: number
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
  if (candidate.eventsSince !== undefined && !Number.isSafeInteger(candidate.eventsSince)) return false
  // A listing carries no lease; everything else does. A method makes it a command,
  // and a lease without one is an event-log read — whose resume point is optional,
  // because the first read has nothing to resume from. Requiring the sequence here
  // made every first read an invalid message, which the shell answers by killing
  // the Host it came from.
  if (candidate.lease === undefined) return candidate.method === undefined && candidate.eventsSince === undefined
  return true
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
    if (request.method === undefined) {
      // The event log the debugger captured, resumed after what the Host saw, with
      // the domains that refused to report so an empty list can explain itself.
      reply({ ...guests.events(request.lease, request.eventsSince) })
      return
    }
    const result = await guests.command(request.lease, request.method ?? '', request.params)
    reply({ result: result ?? null })
  } catch (error: unknown) {
    reply({ error: error instanceof Error ? error.message : String(error) })
  }
}
