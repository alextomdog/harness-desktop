/** Main-process ownership and fixed isolation policy for Sidebar webview guests. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, session, type Session, type WebContents } from 'electron'
import type {
  DesktopBrowserLeaseId,
  DesktopBrowserOpenRequest,
  DesktopBrowserReservation,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { offersPage } from './browser-pages.ts'
import { DESKTOP_IPC } from './ipc.ts'

/**
 * The script every sidebar guest runs before its page does.
 *
 * A gateway's own script asks whether the page is a real Chrome and refuses to load when the answer is
 * this build's brand set — which leaves the document's parser waiting for a script that never arrives,
 * so the page never draws. Chromium reports those brands from the engine, and the only moment they can
 * be answered differently is before the page runs, which is what a preload is for. Written beside the
 * application's data so it is deployed with the app and stays current with it.
 * @returns a file URL for the guest's preload, or undefined when it cannot be written.
 */
// A session exists the first time its partition is used, which is before the guest that needs it — so
// this covers a view that comes back from a previous run and is never handed a fresh reservation. Only
// partitions the sidebar uses: the application's own pages keep the identity they state for themselves.
app.on('session-created', (created) => {
  const storage = created.storagePath
  if (!storage?.includes('dsh-sidebar-browser')) return
  const preload = guestPreloadUrl()
  if (preload === undefined) return
  try {
    created.registerPreloadScript({ type: 'frame', filePath: fileURLToPath(preload) })
  } catch (error) {
    console.error('dsh desktop: the guest preload script could not be registered', error)
  }
})

function guestPreloadUrl(): string | undefined {
  const source = buildGuestPreloadSource()
  try {
    const directory = app.getPath('userData')
    const file = join(directory, 'browser-guest-preload.js')
    mkdirSync(directory, { recursive: true })
    // The file may not be there yet, which is the ordinary first case rather than a failure: reading it
    // before it exists threw, and that throw is what stopped it from ever being written.
    let previous = ''
    try {
      previous = readFileSync(file, 'utf8')
    } catch {
      // Nothing written yet.
    }
    if (!previous.includes(source)) writeFileSync(file, source, 'utf8')
    return pathToFileURL(file).href
  } catch (error) {
    console.error('dsh desktop: writing the guest preload script failed', error)
    return undefined
  }
}

/**
 * The preload's text, kept apart from where it is written so a failure names the step that failed.
 * @returns the script every sidebar guest runs before its page does.
 */
function buildGuestPreloadSource(): string {
  const version = process.versions.chrome
  const major = version.split('.')[0]
  const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'
  const spoof = `try {
  var brands = [
    { brand: 'Chromium', version: '${major}' },
    { brand: 'Not;A=Brand', version: '24' },
    { brand: 'Google Chrome', version: '${major}' },
  ];
  var full = [
    { brand: 'Chromium', version: '${version}' },
    { brand: 'Not;A=Brand', version: '24.0.0.0' },
    { brand: 'Google Chrome', version: '${version}' },
  ];
  var platform = ${JSON.stringify(platform)};
  var data = {
    brands: brands, mobile: false, platform: platform,
    getHighEntropyValues: function () {
      return Promise.resolve({ architecture: 'x86', bitness: '64', brands: brands, fullVersionList: full,
        mobile: false, model: '', platform: platform, platformVersion: '10.0.0',
        uaFullVersion: '${version}', wow64: false, formFactors: ['Desktop'] });
    },
    toJSON: function () { return { brands: brands, mobile: false, platform: platform }; },
  };
  // The getter a real browser reports is a native one, and a script that suspects a rewrite asks exactly
  // that: its toString says [native code]. A getter that answers nothing of the sort is the tell.
  // Measured against a real Chrome on this machine: these three disagreed. An empty window.chrome is the
  // loudest of them — a browser that has the object but none of its parts is the shape of an automated
  // one — so it is given the parts a real Chrome carries, alongside the memory and language it reports.
  try {
    var chromeObject = window.chrome || (window.chrome = {});
    chromeObject.loadTimes = chromeObject.loadTimes || function () { return {}; };
    chromeObject.csi = chromeObject.csi || function () { return {}; };
    chromeObject.app = chromeObject.app || { isInstalled: false, InstallState: {}, RunningState: {} };
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: function () { return 8; } });
    Object.defineProperty(Navigator.prototype, 'languages', { configurable: true, get: function () { return ['zh-CN', 'zh']; } });
  } catch (error) { /* a page that cannot be answered for is left exactly as it was */ }
  var native = 'function get userAgentData() { [native code] }';
  var getter = function () { return data; };
  getter.toString = function () { return native; };
  Object.defineProperty(Navigator.prototype, 'userAgentData', { configurable: true, get: getter });
} catch (error) { /* a page that cannot be answered for is left exactly as it was */ }
`
  // These guests share one world with their preload, so the rewrite below belongs to the page itself and
  // happens before the page's own scripts: exactly the moment a gateway asks its question.
  return spoof
}

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
 *
 * `Debugger` is here for its `scriptParsed` events, which are how the script
 * listing knows what the page loaded without asking it.
 */
const CAPTURED_DOMAINS = ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable', 'Debugger.enable'] as const

/** How long a requested page is waited for, and how often it is looked for. */
const NEW_PAGE_DEADLINE_MS = 15_000
const NEW_PAGE_POLL_MS = 100

/** Owns workspace storage partitions independently from individual tab guests. */
/**
 * The identity the sidebar's pages present, taken from a real Chrome on Windows.
 *
 * A site's gateway decides whether to serve a page before any script runs, and the app's own default
 * user agent names this application and Electron — which such gateways read as "not a browser" and
 * answer with a challenge that never passes. The version here is the one the fingerprint came from, and
 * the client hints below are stated to match it: a user agent claiming one version while the hints
 * claim another is a mismatch of its own.
 */
/**
 * The identity the sidebar's pages present: a plain Chrome, built from the engine actually running here.
 *
 * A site's gateway decides whether to serve a page before any script runs, and the app's own default
 * user agent names this application and Electron — which such gateways read as "not a browser" and answer
 * with a challenge that never passes. The version is taken from the engine rather than written down, so
 * the user agent and the client hints cannot disagree with the engine or with each other: a page claiming
 * one version while the hints claim another is a mismatch of its own.
 */
function browserIdentity(): { userAgent: string; acceptLanguages: string; clientHints: Record<string, string> } {
  const version = process.versions.chrome
  const major = version.split('.')[0] ?? '0'
  const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'
  const os = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64'
  return {
    userAgent: `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
    acceptLanguages: 'zh-CN,zh;q=0.9',
    // Every client hint, not only the short one: Chromium sends the full list and the high-entropy
    // values too, and Electron's own brand appears in them. Overriding one and leaving the rest is how a
    // request ends up naming two different browsers — the shape a gateway reads as not-a-browser.
    // Only what a real Chrome sends unprompted. The high-entropy hints — full version list, platform
    // version, architecture, bitness, model, wow64, form factors — are sent only when a server asks for
    // them by Accept-CH, so sending them on every request is itself the shape of something that is not a
    // browser. Chromium still sends its own when asked; these three are the ones it always sends.
    clientHints: {
      'sec-ch-ua': `"Chromium";v="${major}", "Not;A=Brand";v="24", "Google Chrome";v="${major}"`,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': `"${platform}"`,
    },
  }
}
function applyBrowserIdentity(guestSession: Session): void {
  const identity = browserIdentity()
  guestSession.setUserAgent(identity.userAgent, identity.acceptLanguages)
  guestSession.webRequest.onBeforeSendHeaders((details, callback) => {
    // Rebuilt rather than edited: Chromium's own spellings are left out by name, so a request carries one
    // set of client hints instead of two, and its language is stated once.
    const replaced = new Set([...Object.keys(identity.clientHints), 'accept-language'].map(name => name.toLowerCase()))
    const requestHeaders: Record<string, string> = {}
    for (const [name, value] of Object.entries(details.requestHeaders)) {
      if (!replaced.has(name.toLowerCase())) requestHeaders[name] = value
    }
    Object.assign(requestHeaders, identity.clientHints)
    requestHeaders['Accept-Language'] = identity.acceptLanguages
    callback({ requestHeaders })
  })
}
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
      partition = `persist:dsh-sidebar-browser-${createHash('sha256').update(workspace).digest('hex').slice(0, 32)}`
      const guestSession = session.fromPartition(partition)
      this.configureSession(guestSession)
      applyBrowserIdentity(guestSession)
      this.partitions.set(workspace, partition)
    }
    const lease = randomUUID() as DesktopBrowserLeaseId
    this.leases.set(lease, { owner, partition, attached: false })
    const preload = guestPreloadUrl()
    return preload === undefined ? { lease, partition } : { lease, partition, preload }
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
      console.error('dsh desktop: releasing the browser guest at the client\'s request')
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
      // Registered here, where a guest is actually being created, rather than only where a reservation is
      // handed out: a restored view comes back through this path, and its page runs its own scripts before
      // any later moment. The session may already know this preload, which is not an error.
      const preload = guestPreloadUrl()
      if (preload !== undefined) {
        try {
          session.fromPartition(lease.partition)
            .registerPreloadScript({ type: 'frame', filePath: fileURLToPath(preload) })
        } catch {
          // Already registered for this partition.
        }
      }
      // Keep Electron's allowpopups dispatch flag; the guest handler still denies native windows.
      for (const key of Object.keys(preferences)) {
        if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      }
      Object.assign(preferences, {
        partition: lease.partition,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        // Sandbox and world isolation off deliberately, for these guests only: a sandboxed renderer cannot
        // receive a preload at all, and in an isolated world a preload's rewrite belongs to its own world —
        // it never reaches the page, and a gateway's script reads the page's. Both were needed before such
        // a page could finish loading. The application's own pages and every other window keep theirs.
        contextIsolation: false, sandbox: false, webSecurity: true, allowRunningInsecureContent: false,
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
    // A main-frame navigation used to close every guest this window held. In this application the main
    // frame also navigates for ordinary view and route changes, and those leave the guest documents alive:
    // closing them there destroyed pages — and any form a reader had filled in — for a navigation that had
    // not taken their elements away. Guests still end with their elements, and the hooks below still cover
    // a window that is gone.
    owner.on('render-process-gone', releaseAll)
    owner.once('destroyed', releaseAll)
  }

  /**
   * Every live guest that has a page, oldest first: what an agent driving the
   * built-in browser may address.
   *
   * Two things are filtered, for two different reasons. A lease without an attached
   * guest is a reservation, not a page. A guest without a page — one that has not
   * been navigated yet, or one whose page was closed, leaving it on `about:blank`
   * while Chromium still reports the title it last had — is a document an agent
   * cannot do anything with, and offering it by name is how a closed page keeps
   * showing up in a list of the pages that are open.
   * @returns one entry per addressable page, naming the lease it belongs to.
   */
  list(): readonly { readonly lease: DesktopBrowserLeaseId; readonly url: string; readonly title: string }[] {
    const pages: { lease: DesktopBrowserLeaseId; url: string; title: string }[] = []
    for (const [lease, held] of this.leases) {
      const guest = held.guest
      if (guest === undefined || guest.isDestroyed()) continue
      const url = guest.getURL()
      if (!offersPage(url)) continue
      pages.push({ lease, url, title: guest.getTitle() })
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
   * The script that brings a page's tab to the front.
   *
   * A retained tab that is not the selected one keeps a 0×0 view, and a guest with a
   * 0×0 view has nothing painted for Electron to capture. The shell cannot select a
   * tab — the dock owns that state — but the renderer it belongs to can, through the
   * contract the dock already publishes: a guest element carries its lease as `name`,
   * its `data-dockkit-content` ancestor names the tab, and the strip holds a chip per
   * tab. Clicking that chip is exactly what a person does to look at the page.
   * @param leaseId - the lease of the page to show.
   * @returns the script, which resolves to a short report of what it found.
   */
  private revealScript(leaseId: string): string {
    return `(async () => {
  const guest = [...document.querySelectorAll('webview')].find(el => el.getAttribute('name') === ${JSON.stringify(leaseId)});
  if (!guest) return 'no-guest';
  const cell = guest.closest('[data-dockkit-content]');
  const tabId = cell && cell.dataset.dockkitContent;
  if (!tabId) return 'no-tab';
  const chip = [...document.querySelectorAll('[data-dockkit-tab]')].find(el => el.dataset.dockkitTab === tabId);
  if (!chip) return 'no-chip';
  chip.click();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const rect = guest.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return 'shown';
  }
  return 'still-empty';
})()`
  }

  /**
   * Show a page's tab, so its guest is painted and its area can be captured.
   *
   * Best effort by design: the caller captures afterwards and reports the guest's own
   * refusal when even showing the page produces nothing, which is the only honest
   * thing to say about a page that cannot be painted.
   * @param leaseId - the lease of the page to show.
   */
  private async reveal(leaseId: string): Promise<void> {
    const owner = this.leases.get(leaseId as DesktopBrowserLeaseId)?.owner
    if (owner === undefined || owner.isDestroyed()) return
    await owner.executeJavaScript(this.revealScript(leaseId), true).catch(() => undefined)
  }

  /**
   * Clear what one page's origin keeps, and optionally what it cached.
   *
   * Everything here is scoped to the guest's own partition, which the sidebar created
   * for this workspace: an agent resetting a site must not touch another origin, another
   * window, or the signed-in application around it. `sessionStorage` is not part of the
   * storage-data clear, so it is cleared in the page itself; the page is deliberately
   * NOT reloaded, because a caller may be building state it wants to keep looking at.
   * @param leaseId - the lease received from the Host.
   * @param browserCache - whether to drop the HTTP cache and cached host lookups too.
   */
  async clearSiteData(leaseId: string, browserCache: boolean): Promise<void> {
    const lease = this.leases.get(leaseId as DesktopBrowserLeaseId)
    if (lease?.guest === undefined || lease.guest.isDestroyed()) {
      throw new Error('desktop browser: no live guest holds that lease')
    }
    const guestSession = session.fromPartition(lease.partition)
    await guestSession.clearStorageData()
    if (browserCache) {
      await guestSession.clearCache()
      await guestSession.clearHostResolverCache()
    }
    await lease.guest.executeJavaScript('try { sessionStorage.clear() } catch {}', true).catch(() => undefined)
  }

  /**
   * Discard what capture holds for one page.
   *
   * The sequence keeps counting, so a caller that was reading from a point still gets
   * only what came after it — and a listing that follows a clear says so rather than
   * replaying the traffic the caller asked to forget.
   * @param leaseId - the lease received from the Host.
   * @returns how many events were discarded.
   */
  clearCaptured(leaseId: string): number {
    const guest = this.guestOf(leaseId)
    const held = this.captured.get(guest)
    if (held === undefined) return 0
    const removed = held.events.length
    held.events.splice(0, removed)
    return removed
  }

  /**
   * One page as an image, through Electron rather than the protocol.
   *
   * `Page.captureScreenshot` does not answer for a webview guest: the first live
   * attempt hung until its deadline fired, and it kept doing so after the Page
   * domain was enabled and the full-page flag dropped. Electron's own capture is
   * the API a guest has — but it captures paint, so a page whose tab is not on
   * screen has nothing to give. The page is therefore shown first and the capture
   * retried while the view comes up.
   * @param leaseId - the lease received from the Host.
   * @param format - `png`, or `jpeg` at the given quality.
   * @param quality - JPEG quality 0-100; ignored for png.
   * @returns the image bytes.
   */
  async screenshot(leaseId: string, format: 'png' | 'jpeg', quality?: number): Promise<Uint8Array> {
    const lease = this.leases.get(leaseId as DesktopBrowserLeaseId)
    if (lease?.guest === undefined || lease.guest.isDestroyed()) {
      throw new Error('desktop browser: no live guest holds that lease')
    }
    // A minimized window paints nothing: the whole sidebar lays out to zero and the
    // capture comes back empty. This is worth naming exactly, because it is the
    // difference between "your page cannot be captured" and "restore the window".
    // A live run measured the window at 159×27, minimized, with `document.hidden`
    // true and the sidebar panel zero wide, while the tool blamed the sidebar.
    const window = BrowserWindow.fromWebContents(lease.owner)
    if (window !== null && window.isMinimized()) {
      throw new Error('the application window is minimized, so nothing is being painted and there is no image to take; '
        + 'restore the window and try again')
    }
    await this.reveal(leaseId)
    let bytes = new Uint8Array(0)
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const image = await lease.guest.capturePage()
      // Copied out of the Buffer Electron returns: the same bytes, as a plain array.
      bytes = new Uint8Array(format === 'jpeg' ? image.toJPEG(quality ?? 90) : image.toPNG())
      if (bytes.length > 0) return bytes
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    // Also measured rather than guessed: with the window shown, a page whose tab is
    // not the selected one still keeps a 0×0 view, so there is nothing painted.
    throw new Error('the page has no painted surface to capture: its view measures 0×0, '
      + 'so the tab showing it is not the one on screen (or the sidebar is collapsed)')
  }

  /**
   * Ask the window to open a browser page the Host can then drive.
   *
   * The sidebar owns which tabs exist, so the shell cannot make one: it asks the
   * renderer, which opens it through the app's own tab API, and then waits for the new
   * page to appear. Without this an agent looking at an empty sidebar has no page to
   * address and no way to make one — which is exactly where every live run started.
   * @param url - the absolute http(s) address to open.
   * @returns the new page, or undefined when none appeared before the deadline.
   */
  async newPage(url: string): Promise<{ readonly lease: DesktopBrowserLeaseId; readonly url: string; readonly title: string } | undefined> {
    const owner = this.anyOwner()
    if (owner === undefined) return undefined
    const before = new Set<DesktopBrowserLeaseId>(this.leases.keys())
    owner.send(DESKTOP_IPC.browserNewPageRequested, { url })
    const deadline = Date.now() + NEW_PAGE_DEADLINE_MS
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, NEW_PAGE_POLL_MS))
      const added = this.list().find(page => !before.has(page.lease))
      if (added !== undefined) return added
    }
    return undefined
  }

  /** A live owner window able to open a tab, preferring one that already holds a guest. */
  private anyOwner(): WebContents | undefined {
    for (const held of this.leases.values()) {
      if (!held.owner.isDestroyed()) return held.owner
    }
    return BrowserWindow.getAllWindows().find(window => !window.isDestroyed())?.webContents
  }

  /**
   * The sidebar's open tabs, as the window is showing them.
   *
   * Read from the window's own DOM rather than from a second copy kept somewhere: the dock
   * already publishes exactly this — a chip per tab, and a content cell per open tab whose
   * cell is displayed only while that tab is the one on screen — so the answer is what the
   * reader sees, not what some earlier event said they should be seeing.
   * @returns one entry per open tab, or an empty list when no window can answer.
   */
  async openTabs(): Promise<readonly { readonly title: string; readonly visible: boolean }[]> {
    const owner = this.anyOwner()
    if (owner === undefined) return []
    const script = `(() => {
  const chips = [...document.querySelectorAll('[data-dockkit-tab]')];
  const titles = new Map(chips.map(chip => [chip.dataset.dockkitTab, (chip.textContent || '').trim()]));
  return [...document.querySelectorAll('[data-dockkit-content]')].map(cell => {
    const host = cell.closest('[class*=tabCell]');
    return {
      title: titles.get(cell.dataset.dockkitContent) || '',
      visible: host !== null && getComputedStyle(host).display !== 'none',
    };
  }).filter(tab => tab.title !== '');
})()`
    try {
      const tabs = await owner.executeJavaScript(script, true) as unknown
      return Array.isArray(tabs) ? tabs as { title: string; visible: boolean }[] : []
    } catch {
      // A window mid-reload has no dock yet; "nothing open" is the honest answer then.
      return []
    }
  }

  /** The live guest a lease names, or a refusal. */
  private guestOf(leaseId: string): WebContents {
    const guest = this.leases.get(leaseId as DesktopBrowserLeaseId)?.guest
    if (guest === undefined || guest.isDestroyed()) {
      // Naming the lease is what turns "a tool failed" into "this lease's page was already gone".
      console.error('dsh desktop: a tool asked for a guest whose lease has no live page', leaseId)
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
      // A guest that dies takes every page it held with it, and until now nothing said so: the tools
      // answered "no live guest holds that lease" long after the fact, with no record of the moment the
      // page was lost. The reason is recorded here, and a crash also reloads the page the reader is
      // looking at instead of leaving a dead blank where their form was.
      guest.on('render-process-gone', (_event, details) => {
        console.error('dsh desktop: browser guest process gone:', details.reason, 'exit', String(details.exitCode))
        if (details.reason === 'clean-exit' || guest.isDestroyed()) return
        guest.reload()
      })
      // What this guest is showing, kept only so that losing it can be named. A guest that dies takes its
      // pages with it, and a log that lists them is what lets the reader open them again — the forms they
      // had filled in cannot be recovered, but the pages they were on can.
      const showing = new Map<string, string>()
      const remember = (): void => {
        const url = guest.getURL()
        if (url !== '' && !url.startsWith('about:')) showing.set(url, guest.getTitle())
      }
      guest.on('did-navigate', remember)
      guest.on('did-navigate-in-page', remember)
      guest.on('page-title-updated', remember)
      guest.once('destroyed', () => {
        if (showing.size > 0) {
          console.error('dsh desktop: the pages this guest was showing:', [...showing.keys()].join(' | '))
        }
      })
      guest.once('destroyed', () => {
        console.error('dsh desktop: browser guest destroyed')
        // The lease outlived its page: drop it so a later command names a missing lease rather than a
        // lease whose guest is a corpse.
        for (const [id, held] of this.leases) {
          if (held.guest === guest) this.leases.delete(id)
        }
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
    // A page in the sidebar may copy for the reader — "copy to clipboard" is an ordinary page
    // action, and refusing it made a page's own button throw. Nothing else is granted: the
    // denial is what keeps a page from asking for a camera, a microphone or a location through
    // a panel the reader did not open as a browser. `clipboard-sanitized-write` is Chromium's
    // name for the write a page performs on the reader's own click.
    const allowed = (permission: string): boolean => permission === 'clipboard-sanitized-write'
    browserSession.setPermissionRequestHandler((_contents, permission, callback) => { callback(allowed(permission)) })
    browserSession.setPermissionCheckHandler((_contents, permission) => allowed(permission))
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
