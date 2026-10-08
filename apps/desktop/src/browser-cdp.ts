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
  /**
   * Screenshot request. Present means "capture this page as an image"; the shell
   * uses Electron's own capture, because the protocol's does not answer for a
   * webview guest.
   */
  readonly screenshot?: { readonly format?: string; readonly quality?: number }
  /**
   * A page to open. Present means "make one", and it is the only request that carries
   * no lease: it is what an agent asks for when there is nothing to address yet.
   */
  readonly newPage?: { readonly url: string }
  /**
   * The sidebar's open tabs. Present means "report them": an agent that can see the page it
   * may drive should also see the file the reader is actually working in.
   */
  readonly openTabs?: true
  /**
   * Discard what capture holds for this lease.
   *
   * Present means "forget it": a caller about to reproduce an action asks for a clean
   * window, and the events already held are the ones it does not want to read past.
   */
  readonly clear?: 'events'
  /**
   * Clear this page's site data. Present means "reset what the origin keeps"; the
   * optional flag adds the caches, and the page is not reloaded either way.
   */
  readonly clearSiteData?: { readonly browserCache?: boolean }
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
  if (candidate.openTabs !== undefined && candidate.openTabs !== true) return false
  if (candidate.newPage !== undefined) {
    if (typeof candidate.newPage !== 'object' || candidate.newPage === null) return false
    const open = candidate.newPage as Record<string, unknown>
    // Only a page the browser itself may visit: the renderer hands this straight to the
    // tab, and a scheme it cannot follow would open a tab that goes nowhere.
    return typeof open.url === 'string' && /^https?:\/\//i.test(open.url)
  }
  if (candidate.clearSiteData !== undefined) {
    if (typeof candidate.clearSiteData !== 'object' || candidate.clearSiteData === null
      || Array.isArray(candidate.clearSiteData)) return false
    const site = candidate.clearSiteData as Record<string, unknown>
    if (site.browserCache !== undefined && typeof site.browserCache !== 'boolean') return false
    return typeof candidate.lease === 'string'
  }
  if (candidate.clear !== undefined && candidate.clear !== 'events') return false
  if (candidate.eventsSince !== undefined && !Number.isSafeInteger(candidate.eventsSince)) return false
  if (candidate.screenshot !== undefined) {
    if (typeof candidate.screenshot !== 'object' || candidate.screenshot === null
      || Array.isArray(candidate.screenshot)) return false
    const shot = candidate.screenshot as Record<string, unknown>
    if (shot.format !== undefined && shot.format !== 'png' && shot.format !== 'jpeg') return false
    if (shot.quality !== undefined && typeof shot.quality !== 'number') return false
    return typeof candidate.lease === 'string'
  }
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
    if (request.openTabs === true) {
      reply({ tabs: await guests.openTabs() })
      return
    }
    if (request.newPage !== undefined) {
      reply({ page: await guests.newPage(request.newPage.url) ?? null })
      return
    }
    if (request.lease === undefined) {
      reply({ pages: guests.list() })
      return
    }
    // Screenshot first. It carries a lease and NO method, so testing for a missing
    // method before it made every capture read the event log instead and reply with
    // an empty one — which the Host reports as "the shell returned no image", a
    // message about the image that was never taken.
    if (request.screenshot !== undefined) {
      const format = request.screenshot.format === 'jpeg' ? 'jpeg' : 'png'
      const image = await guests.screenshot(request.lease, format, request.screenshot.quality)
      reply({ data: Buffer.from(image).toString('base64'), format })
      return
    }
    if (request.clearSiteData !== undefined) {
      await guests.clearSiteData(request.lease, request.clearSiteData.browserCache === true)
      reply({ cleared: true })
      return
    }
    if (request.clear === 'events') {
      reply({ removed: guests.clearCaptured(request.lease) })
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
