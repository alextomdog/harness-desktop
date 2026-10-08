/**
 * The Host's half of the built-in browser bridge.
 *
 * The sidebar's pages are webview guests owned by the Electron shell — a different
 * process, which the Host cannot see into. Asking the shell over the child's IPC
 * channel is the only way an agent reaches them, and it is the same request and
 * correlated reply the shell's own control messages already use.
 *
 * Every request carries a deadline. A shell that stopped answering must fail the
 * tool that asked rather than hang it, and an unanswered request is dropped so a
 * late reply cannot resolve a promise nobody holds.
 */

/** One live page the shell holds. */
export interface DesktopBrowserPage {
  /** The lease the page belongs to; every other call addresses the page by it. */
  readonly lease: string
  readonly url: string
  readonly title: string
}

/** One captured protocol event, as the shell holds it. */
export interface DesktopBrowserEvent {
  /** Monotonic across the page's lifetime. */
  readonly seq: number
  /** The protocol method, such as `Network.requestWillBeSent`. */
  readonly method: string
  readonly params: unknown
}

/** One protocol domain that refused to start reporting, and why. */
export interface DesktopBrowserRefusal {
  readonly domain: string
  readonly reason: string
}

/** What one page's capture holds. */
export interface DesktopBrowserCapture {
  /** The events, oldest first. */
  readonly events: readonly DesktopBrowserEvent[]
  /**
   * The domains that would not report. Carried because an empty list and a domain
   * that never started look identical to a reader — and did, to me, until a live
   * run reported two working tools returning nothing.
   */
  readonly refused: readonly DesktopBrowserRefusal[]
}

/** What the Host asks of the shell. */
export interface DesktopBrowserControl {
  /** The live pages, oldest first. */
  list(): Promise<readonly DesktopBrowserPage[]>
  /** Run one DevTools Protocol command against one page. */
  command(lease: string, method: string, params?: Record<string, unknown>): Promise<unknown>
  /**
   * The events one page captured after a point, and the domains that refused.
   * @param lease - the page.
   * @param since - the last sequence already seen, or absent for everything held.
   * @returns the new events and the refusals.
   */
  events(lease: string, since?: number): Promise<DesktopBrowserCapture>
  /**
   * One page as an image, captured by the shell with Electron's own API.
   * @param lease - the page.
   * @param format - `png`, or `jpeg` at the given quality.
   * @param quality - JPEG quality 0-100; ignored for png.
   * @returns the image bytes.
   */
  screenshot(lease: string, format: 'png' | 'jpeg', quality?: number): Promise<Uint8Array>
  /**
   * Ask the shell's window to open a page, and wait for it.
   * @param url - the absolute http(s) address to open.
   * @returns the new page, or undefined when none appeared.
   */
  newPage(url: string): Promise<DesktopBrowserPage | undefined>
  /**
   * Discard the events captured for one page.
   * @param lease - the page.
   * @returns how many events were discarded.
   */
  clearEvents(lease: string): Promise<number>
  /**
   * Route one message from the shell.
   * @param message - the message, as received.
   * @returns whether this bridge consumed it.
   */
  handle(message: unknown): boolean
}

/** Deadline for one shell answer: a stalled shell must not stall a tool. */
export const BROWSER_COMMAND_DEADLINE_MS = 15_000

/**
 * Install the control over this process's IPC channel to the shell.
 * @param deadlineMs - how long one answer may take.
 * @returns the control, and the message router for the shell's replies.
 */
export function installDesktopBrowserControl(deadlineMs = BROWSER_COMMAND_DEADLINE_MS): DesktopBrowserControl {
  let nextId = 1
  const pending = new Map<number, {
    resolve: (reply: Record<string, unknown>) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  const ask = (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const requestId = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error('desktop browser: the shell did not answer in time'))
      }, deadlineMs)
      pending.set(requestId, { resolve, reject, timer })
      if (!process.connected || process.send === undefined) {
        clearTimeout(timer)
        pending.delete(requestId)
        reject(new Error('desktop browser: the shell is not connected'))
        return
      }
      process.send({ type: 'browser-command', requestId, ...payload }, (error) => {
        if (error === null) return
        clearTimeout(timer)
        pending.delete(requestId)
        reject(error)
      })
    })
  }
  return {
    async list(): Promise<readonly DesktopBrowserPage[]> {
      const reply = await ask({})
      const pages = reply.pages
      return Array.isArray(pages) ? pages as readonly DesktopBrowserPage[] : []
    },
    async command(lease, method, params): Promise<unknown> {
      const reply = await ask({ lease, method, ...params === undefined ? {} : { params } })
      if (typeof reply.error === 'string') throw new Error(`desktop browser: ${reply.error}`)
      return reply.result
    },
    async events(lease, since): Promise<DesktopBrowserCapture> {
      const reply = await ask({ lease, ...since === undefined ? {} : { eventsSince: since } })
      if (typeof reply.error === 'string') throw new Error(`desktop browser: ${reply.error}`)
      return {
        events: Array.isArray(reply.events) ? reply.events as readonly DesktopBrowserEvent[] : [],
        refused: Array.isArray(reply.refused) ? reply.refused as readonly DesktopBrowserRefusal[] : [],
      }
    },
    async screenshot(lease, format, quality): Promise<Uint8Array> {
      const reply = await ask({ lease, screenshot: { format, ...quality === undefined ? {} : { quality } } })
      if (typeof reply.error === 'string') throw new Error(`desktop browser: ${reply.error}`)
      if (typeof reply.data !== 'string' || reply.data === '') throw new Error('desktop browser: the shell returned no image')
      return Uint8Array.from(Buffer.from(reply.data, 'base64'))
    },
    async newPage(url): Promise<DesktopBrowserPage | undefined> {
      const reply = await ask({ newPage: { url } })
      if (typeof reply.error === 'string') throw new Error(`desktop browser: ${reply.error}`)
      const page = reply.page
      return page === null || page === undefined ? undefined : page as DesktopBrowserPage
    },
    async clearEvents(lease): Promise<number> {
      const reply = await ask({ lease, clear: 'events' })
      if (typeof reply.error === 'string') throw new Error(`desktop browser: ${reply.error}`)
      return typeof reply.removed === 'number' ? reply.removed : 0
    },
    handle(message: unknown): boolean {
      if (typeof message !== 'object' || message === null) return false
      const candidate = message as Record<string, unknown>
      if (candidate.type !== 'browser-command' || !Number.isSafeInteger(candidate.requestId)) return false
      const held = pending.get(candidate.requestId as number)
      // A reply nobody waits on is still this bridge's message, not a protocol error.
      if (held === undefined) return true
      clearTimeout(held.timer)
      pending.delete(candidate.requestId as number)
      held.resolve(candidate)
      return true
    },
  }
}
