/** Main-process ownership and fixed isolation policy for Sidebar webview guests. */
import { randomUUID } from 'node:crypto'
import { app, session, type BrowserWindow, type Session, type WebContents } from 'electron'
import type { DesktopBrowserLeaseId, DesktopBrowserOpenRequest, DesktopBrowserReservation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'

interface GuestLease {
  readonly owner: WebContents
  readonly partition: string
  attached: boolean
  guest?: WebContents
  releaseInput?: () => void
}

/** One captured DevTools event, ordered so a reader can ask for what is new. */
export interface DesktopBrowserEvent {
  /** Monotonic across the page's lifetime; a reader resumes after the last one it saw. */
  readonly seq: number
  /** The protocol method, such as `Network.requestWillBeSent`. */
  readonly method: string
  readonly params: unknown
}

/**
 * How many events one page keeps. Enough for a listing to be useful, bounded so a
 * chatty page cannot grow the shell's memory without end.
 */
const MAX_CAPTURED_EVENTS = 1_000

/** One protocol domain that refused to start reporting, and why. */
export interface DesktopBrowserRefusal {
  readonly domain: string
  readonly reason: string
}

/** What capture holds for one page: the events, and the domains that refused. */
interface Capture {
  readonly events: DesktopBrowserEvent[]
  next: number
  readonly refused: DesktopBrowserRefusal[]
}

/**
 * The domains whose events the tools read, and whose commands they run.
 *
 * `Page` is here for `Page.captureScreenshot`: a screenshot command against a
 * target whose Page domain was never enabled does not answer, and the tool that
 * asked fails on its deadline with nothing to say about why.
 */
const CAPTURED_DOMAINS = ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable'] as const

/** Owns workspace storage partitions independently from individual tab guests. */
export class DesktopBrowserGuests {
  private readonly partitions = new Map<string, string>()
  private readonly leases = new Map<DesktopBrowserLeaseId, GuestLease>()
  /** Captured events per guest, oldest first, and the sequence the next one takes. */
  private readonly captured = new Map<WebContents, Capture>()

  /** @param hostUrl - current authenticated DSH Host, which guests cannot request. */
  constructor(private readonly hostUrl: () => string | undefined) {}

  /**
   * Reserve one guest in a workspace's process-lifetime partition.
   * @param owner - authenticated primary application WebContents.
   * @param workspace - workspace identity received over IPC.
   * @returns opaque lease and the partition approved for it.
   */
  acquire(owner: WebContents, workspace: unknown): DesktopBrowserReservation {
    if (typeof workspace !== 'string' || workspace.length === 0 || workspace.length > 4096) {
      throw new Error('desktop browser: a workspace storage identity is required')
    }
    let partition = this.partitions.get(workspace)
    if (partition === undefined) {
      partition = `dsh-sidebar-browser-${randomUUID()}`
      this.configureSession(session.fromPartition(partition))
      this.partitions.set(workspace, partition)
    }
    const lease = randomUUID() as DesktopBrowserLeaseId
    this.leases.set(lease, { owner, partition, attached: false })
    return { lease, partition }
  }

  /**
   * Release only a lease issued to this application window; workspace storage survives.
   * @param owner - authenticated IPC sender.
   * @param id - lease received over IPC.
   */
  async release(owner: WebContents, id: unknown): Promise<void> {
    if (typeof id !== 'string') throw new Error('desktop browser: invalid guest lease')
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined) return
    if (lease.owner !== owner) throw new Error('desktop browser: guest belongs to another window')
    lease.releaseInput?.()
    this.leases.delete(key)
    const guest = lease.guest
    if (guest !== undefined && !guest.isDestroyed()) {
      const destroyed = new Promise<void>((resolve) => { guest.once('destroyed', resolve) })
      guest.close({ waitForBeforeUnload: false })
      await destroyed
    }
  }

  /**
   * Install attachment checks before the application document can create a webview.
   * @param window - primary application window.
   * @param attachInput - attaches native input after guest ownership is verified and returns its disposer.
   */
  bind(window: BrowserWindow, attachInput: (guest: WebContents, name: DesktopBrowserLeaseId) => () => void): void {
    const owner = window.webContents
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id = typeof params.src === 'string' && params.src.startsWith('about:blank#')
        ? params.src.slice('about:blank#'.length) : ''
      const lease = this.leases.get(id as DesktopBrowserLeaseId)
      if (lease === undefined || lease.owner !== owner || lease.attached || params.partition !== lease.partition) {
        event.preventDefault()
        return
      }
      lease.attached = true
      // Keep Electron's allowpopups dispatch flag; the guest handler still denies native windows.
      for (const key of Object.keys(preferences)) {
        if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      }
      Object.assign(preferences, {
        partition: lease.partition,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true,
        devTools: !app.isPackaged,
      })
      params.httpreferrer = ''
    })
    owner.on('did-attach-webview', (_event, guest) => {
      // Attach before anything else. The renderer points the new guest at its URL
      // as soon as it creates it, and a protocol domain reports only from the
      // moment it is enabled — so attaching on `dom-ready` lost the very load the
      // tools exist to read. This is the earliest the guest is addressable at all.
      void this.attach(guest).catch((error: unknown) => { console.error(error) })
      let attachedLease: DesktopBrowserLeaseId | undefined
      // The first document is an inert about:blank carrying the approved lease.
      // Bind on the main-process event before the renderer can navigate the ready guest.
      guest.once('dom-ready', () => {
        const url = guest.getURL()
        const id = (url.startsWith('about:blank#') ? url.slice('about:blank#'.length) : '') as DesktopBrowserLeaseId
        const lease = this.leases.get(id)
        if (lease === undefined || lease.owner !== owner || lease.guest !== undefined) {
          guest.close({ waitForBeforeUnload: false })
          return
        }
        lease.guest = guest
        attachedLease = id
        lease.releaseInput = attachInput(guest, id)
        guest.once('destroyed', () => { lease.releaseInput?.(); this.leases.delete(id) })
      })
      guest.setWindowOpenHandler(({ url, postBody }) => {
        const lease = attachedLease === undefined ? undefined : this.leases.get(attachedLease)
        if (attachedLease !== undefined && lease?.guest === guest && lease.owner === owner && !owner.isDestroyed()
          && postBody === undefined && this.allowedNavigation(url)) {
          const request: DesktopBrowserOpenRequest = { lease: attachedLease, url: new URL(url).href }
          owner.send(DESKTOP_IPC.browserOpenRequested, request)
        }
        return { action: 'deny' }
      })
      guest.on('will-frame-navigate', (event) => {
        if (event.isMainFrame && !this.allowedNavigation(event.url)) event.preventDefault()
      })
      guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
        if (mainFrame && !this.allowedNavigation(url)) event.preventDefault()
      })
      guest.on('will-attach-webview', (event) => { event.preventDefault() })
      guest.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
    })
    const releaseAll = (): void => {
      for (const [id, lease] of this.leases) {
        if (lease.owner === owner) void this.release(owner, id).catch((error: unknown) => { console.error(error) })
      }
    }
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) releaseAll()
    })
    owner.on('render-process-gone', releaseAll)
    owner.once('destroyed', releaseAll)
  }

  /**
   * Every live guest, oldest first: what an agent driving the built-in browser may
   * address. A lease without an attached guest is a reservation, not a page.
   * @returns one entry per live page, naming the lease it belongs to.
   */
  list(): readonly { readonly lease: DesktopBrowserLeaseId; readonly url: string; readonly title: string }[] {
    const pages: { lease: DesktopBrowserLeaseId; url: string; title: string }[] = []
    for (const [lease, held] of this.leases) {
      const guest = held.guest
      if (guest === undefined || guest.isDestroyed()) continue
      pages.push({ lease, url: guest.getURL(), title: guest.getTitle() })
    }
    return pages
  }

  /**
   * Run one DevTools Protocol command against a lease's guest.
   *
   * The guest is an out-of-process frame: the renderer cannot read into it, and
   * neither can the Host, which runs as a separate process. This main-process
   * debugger attachment is therefore the only path an agent has to the page the
   * sidebar is showing — which is the whole point of the bridge.
   * @param leaseId - the lease received from the Host.
   * @param method - a DevTools Protocol method name.
   * @param params - the method's parameters, or nothing.
   * @returns the protocol result.
   * @throws when no live guest holds that lease.
   */
  async command(leaseId: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
    const guest = this.guestOf(leaseId)
    await this.attach(guest)
    return await guest.debugger.sendCommand(method, params)
  }

  /**
   * The events captured for one page after a point, and the domains that refused.
   *
   * The refusals travel with the events because an empty list and a domain that
   * never started reporting look identical to a reader, and a silent catch made
   * them identical to me as well: two working tools returned empty lists and
   * nothing anywhere said why.
   * @param leaseId - the lease received from the Host.
   * @param since - the last sequence the caller already saw, or absent for everything held.
   * @returns the new events, oldest first, and the domains that would not report.
   */
  events(leaseId: string, since?: number): {
    readonly events: readonly DesktopBrowserEvent[]
    readonly refused: readonly DesktopBrowserRefusal[]
  } {
    const guest = this.guestOf(leaseId)
    const held = this.captured.get(guest)
    if (held === undefined) return { events: [], refused: [] }
    return {
      events: since === undefined ? [...held.events] : held.events.filter(event => event.seq > since),
      refused: held.refused,
    }
  }

  /**
   * One page as an image, through Electron rather than the protocol.
   *
   * `Page.captureScreenshot` does not answer for a webview guest: the first live
   * attempt hung until its deadline fired, and it kept doing so after the Page
   * domain was enabled and the full-page flag dropped. Electron's own capture is
   * the API a guest has.
   * @param leaseId - the lease received from the Host.
   * @param format - `png`, or `jpeg` at the given quality.
   * @param quality - JPEG quality 0-100; ignored for png.
   * @returns the image bytes.
   */
  async screenshot(leaseId: string, format: 'png' | 'jpeg', quality?: number): Promise<Uint8Array> {
    const image = await this.guestOf(leaseId).capturePage()
    return format === 'jpeg' ? image.toJPEG(quality ?? 90) : image.toPNG()
  }

  /** The live guest a lease names, or a refusal. */
  private guestOf(leaseId: string): WebContents {
    const guest = this.leases.get(leaseId as DesktopBrowserLeaseId)?.guest
    if (guest === undefined || guest.isDestroyed()) {
      throw new Error('desktop browser: no live guest holds that lease')
    }
    return guest
  }

  /**
   * Attach the debugger once per guest, and start capturing the domains the tools
   * read. Enabling a domain is what makes the protocol emit its events at all, so
   * a page nobody has commanded yet still reports its console and its traffic.
   * @param guest - the guest to attach.
   */
  private async attach(guest: WebContents): Promise<void> {
    if (!guest.debugger.isAttached()) {
      guest.debugger.attach('1.3')
      const held: Capture = { events: [], next: 1, refused: [] }
      this.captured.set(guest, held)
      guest.debugger.on('message', (_event, method, params) => {
        held.events.push({ seq: held.next++, method, params })
        if (held.events.length > MAX_CAPTURED_EVENTS) held.events.splice(0, held.events.length - MAX_CAPTURED_EVENTS)
      })
      guest.once('destroyed', () => { this.captured.delete(guest) })
      for (const domain of CAPTURED_DOMAINS) {
        // A domain the page refuses is not fatal, but it IS recorded: a tool that
        // silently reports nothing is worse than one that says what is missing.
        try {
          await guest.debugger.sendCommand(domain)
        } catch (error: unknown) {
          held.refused.push({
            domain,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  }

  private configureSession(browserSession: Session): void {
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    browserSession.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })
    browserSession.on('will-download', (event) => { event.preventDefault() })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const network = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      callback({ cancel: network
        ? url.username !== '' || url.password !== '' || this.isApplicationHost(url)
        : !['about:', 'data:', 'blob:'].includes(url.protocol) })
    })
  }

  private allowedNavigation(value: string): boolean {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === ''
      && !this.isApplicationHost(url)
  }

  private isApplicationHost(url: URL): boolean {
    const value = this.hostUrl()
    if (value === undefined) return false
    const host = new URL(value)
    return url.port === host.port
      && (url.hostname === host.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  }
}
