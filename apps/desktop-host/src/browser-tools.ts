/**
 * The built-in browser's tools: what lets an agent drive the page the sidebar is
 * showing, rather than a browser somewhere else on the machine.
 *
 * The names are the DevTools-protocol MCP's names on purpose — an agent that
 * already knows `navigate_page`, `evaluate_script`, and `select_page` should not
 * have to learn a second vocabulary to reach the window in front of the user. What
 * changes is the target: these address the sidebar's own webview guests, through
 * the shell, and nothing outside the application.
 *
 * `pageIdx` selects a page for the call. It is resolved from the same list
 * `select_page` reports, so an agent reads the list once and addresses pages by
 * position exactly as the protocol MCP describes.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: this is what puts `ctx.fs` on the context. The screenshot writes its
// bytes through the same seam every other Host write uses.
import type {} from '@deepseek-ai/dsh-fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopBrowserCapture, DesktopBrowserControl, DesktopBrowserEvent, DesktopBrowserPage } from './browser-cdp.ts'

/** The page list, and the page one call addresses. */
interface Target {
  readonly pages: readonly DesktopBrowserPage[]
  readonly page: DesktopBrowserPage | undefined
}

/**
 * Resolve the pages, and the one a call addresses.
 * @param control - the bridge.
 * @param pageIdx - the zero-based page position, or absent for the only page.
 * @returns the list and the resolved page.
 * @throws when the position does not exist, or is ambiguous because none was given.
 */
async function resolveTarget(control: DesktopBrowserControl, pageIdx: number | undefined): Promise<Target> {
  const pages = await control.list()
  if (pages.length === 0) {
    throw new Error('no page is open in the built-in browser: open one in the right sidebar first')
  }
  if (pageIdx === undefined) {
    const only = pages[0]
    if (pages.length > 1) {
      throw new Error(`the built-in browser has ${String(pages.length)} pages: pass pageIdx, as select_page lists them`)
    }
    return { pages, page: only }
  }
  const page = pages[pageIdx]
  if (page === undefined) throw new Error(`no page at pageIdx ${String(pageIdx)}: ${String(pages.length)} are open`)
  return { pages, page }
}

/** A page as the tools report it. */
function describe(page: DesktopBrowserPage, index: number): { pageIdx: number; url: string; title: string } {
  return { pageIdx: index, url: page.url, title: page.title }
}

/** The `Runtime.evaluate` result, as far as these tools read it. */
interface RuntimeEvaluation {
  readonly result?: { readonly value?: unknown; readonly description?: string }
  readonly exceptionDetails?: {
    readonly text?: string
    readonly exception?: { readonly description?: string }
  }
}

/** Deadline for a navigation to show up in the guest's address. */
const NAVIGATION_SETTLE_MS = 5_000

/**
 * Wait for the guest's address to move away from where it was.
 *
 * A navigation command returns before the navigation happens, so reading the
 * address immediately reports the OLD one: an agent that trusted it would conclude
 * the call failed when it had in fact succeeded — which is exactly what one
 * reported after a working navigation. Waiting for the address to change is the
 * cheap truthful answer; a redirect or a slow host ends at the deadline instead.
 * @param control - the bridge.
 * @param lease - the page being navigated.
 * @param before - the address it held when the command was issued.
 * @returns the address now, and whether it moved.
 */
async function waitForAddress(
  control: DesktopBrowserControl,
  lease: string,
  before: string,
): Promise<{ url: string; moved: boolean }> {
  const until = Date.now() + NAVIGATION_SETTLE_MS
  let url = before
  for (;;) {
    const pages = await control.list()
    url = pages.find(candidate => candidate.lease === lease)?.url ?? url
    if (url !== before) return { url, moved: true }
    if (Date.now() >= until) return { url, moved: false }
    await new Promise((resolve) => { setTimeout(resolve, 150) })
  }
}

/**
 * Register the built-in browser tools.
 *
 * A plugin rather than a bare call: `ctx.tools` is a service, and cordis refuses
 * to hand one over without an `inject` declaration — reaching for it directly made
 * the whole Host fail to start. Declaring it also makes the tools wait for the
 * registry instead of racing it.
 */
export const browserToolsPlugin = {
  name: 'desktop-browser-tools',
  inject: ['tools', 'fs'],
  apply(ctx: Context, control: DesktopBrowserControl): void {
    registerBrowserTools(ctx, control)
  },
}

/**
 * Register the tools against one bridge.
 * @param ctx - the plugin context carrying the tool registry.
 * @param control - the shell bridge.
 */
function registerBrowserTools(ctx: Context, control: DesktopBrowserControl): void {
  ctx.tools.register(defineTool({
    name: 'select_page',
    description: 'List the pages the built-in browser (the right sidebar) has open, or pick one for later calls. '
      + 'This drives the browser inside this application, never another one on the machine.',
    parameters: {
      pageIdx: { type: 'number', description: 'Zero-based page to select. Omit to list every page.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pages: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                pageIdx: { type: 'number', required: true },
                url: { type: 'string', required: true },
                title: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.pages.length === 0
          ? 'No page is open in the built-in browser.'
          : value.pages.map(page => `${String(page.pageIdx)}: ${page.title} — ${page.url}`).join('\n'),
      }],
    },
    async execute(args) {
      const pages = await control.list()
      const selected = args.pageIdx === undefined ? undefined : pages[args.pageIdx]
      if (args.pageIdx !== undefined && selected === undefined) {
        throw new Error(`no page at pageIdx ${String(args.pageIdx)}: ${String(pages.length)} are open`)
      }
      return { pages: pages.map(describe) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'navigate_page',
    description: 'Navigate, reload, go back, or go forward in a page of the built-in browser.',
    parameters: {
      type: {
        type: 'string', enum: ['url', 'reload', 'back', 'forward'],
        description: 'Navigation action. Defaults to url, which needs a url.',
      },
      url: { type: 'string', description: 'Absolute URL to load when type is url.' },
      pageIdx: { type: 'number', description: 'Page to act on, as select_page lists it. Defaults to the only page.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          moved: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        // What the page reports, and whether it actually went anywhere. A reload
        // keeps its address, so it is reported as landed rather than as a failure.
        text: value.moved || value.url !== ''
          ? `Navigated to ${value.url}`
          : 'The page did not report an address after the command.',
      }],
    },
    async execute(args) {
      const { page } = await resolveTarget(control, args.pageIdx)
      if (page === undefined) throw new Error('no page to navigate')
      const before = page.url
      const type = args.type ?? 'url'
      if (type === 'url') {
        if (args.url === undefined || args.url === '') throw new Error('type url needs a url')
        await control.command(page.lease, 'Page.navigate', { url: args.url })
      } else if (type === 'reload') {
        await control.command(page.lease, 'Page.reload')
      } else {
        // History lives in the guest; walking it needs the entry the protocol
        // reports rather than an offset.
        const history = await control.command(page.lease, 'Page.getNavigationHistory') as {
          currentIndex?: number
          entries?: readonly { id: number }[]
        }
        const index = (history.currentIndex ?? 0) + (type === 'back' ? -1 : 1)
        const entry = history.entries?.[index]
        if (entry === undefined) throw new Error(`no ${type} entry in this page's history`)
        await control.command(page.lease, 'Page.navigateToHistoryEntry', { entryId: entry.id })
      }
      // The command returns before the page moves, so read the address back until
      // it changes. A redirect lands somewhere else and is reported as it is.
      const landed = await waitForAddress(control, page.lease, before)
      return { url: landed.url, moved: type === 'reload' ? true : landed.moved }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'evaluate_script',
    description: 'Evaluate one JavaScript function in a page of the built-in browser and return its value. '
      + 'Pass a function expression, for example "() => document.title".',
    parameters: {
      function: { type: 'string', required: true, description: 'JavaScript function expression to evaluate.' },
      pageIdx: { type: 'number', description: 'Page to evaluate in, as select_page lists it. Defaults to the only page.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { value: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.value }],
    },
    async execute(args) {
      const { page } = await resolveTarget(control, args.pageIdx)
      if (page === undefined) throw new Error('no page to evaluate in')
      const evaluation = await control.command(page.lease, 'Runtime.evaluate', {
        expression: `(${args.function})()`,
        awaitPromise: true,
        returnByValue: true,
      }) as RuntimeEvaluation
      if (evaluation.exceptionDetails !== undefined) {
        throw new Error(evaluation.exceptionDetails.exception?.description
          ?? evaluation.exceptionDetails.text ?? 'the page threw while evaluating')
      }
      const value = evaluation.result?.value
      return { value: typeof value === 'string' ? value : JSON.stringify(value ?? evaluation.result?.description ?? null) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'take_screenshot',
    description: 'Capture a page of the built-in browser as an image, save it to a file, and return the path. '
      + 'Read the file back with read_image to look at it.',
    parameters: {
      pageIdx: { type: 'number', description: 'Page to capture, as select_page lists it. Defaults to the only page.' },
      format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format. Defaults to png.' },
      quality: { type: 'number', description: 'JPEG quality 0-100. Ignored for png.' },
      filePath: { type: 'string', description: 'Where to write the image. Defaults to a temporary file.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Saved a ${String(value.bytes)}-byte screenshot to ${value.path}. Read it with read_image.`,
      }],
    },
    async execute(args) {
      const { page } = await resolveTarget(control, args.pageIdx)
      if (page === undefined) throw new Error('no page to capture')
      const format = args.format ?? 'png'
      const shot = await control.command(page.lease, 'Page.captureScreenshot', {
        format,
        ...format === 'jpeg' && args.quality !== undefined ? { quality: args.quality } : {},
        // The whole document, not just the part the pane happens to show: an agent
        // reading a screenshot is usually looking for something below the fold.
        captureBeyondViewport: true,
      }) as { data?: string }
      if (shot.data === undefined || shot.data === '') throw new Error('the page returned no image data')
      const bytes = Buffer.from(shot.data, 'base64')
      const path = args.filePath ?? join(tmpdir(), `dsh-browser-${String(Date.now())}.${format === 'jpeg' ? 'jpg' : 'png'}`)
      const target = await ctx.fs.resolve(path)
      await ctx.fs.writeBytes(target, new Uint8Array(bytes))
      return { path, bytes: bytes.length }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_console_messages',
    description: 'Inspect console messages and uncaught page errors captured for a page of the built-in browser.',
    parameters: {
      pageIdx: { type: 'number', description: 'Page to read, as select_page lists it. Defaults to the only page.' },
      pageSize: { type: 'number', description: 'Maximum messages to return, newest last. Defaults to 20.' },
      types: {
        type: 'array', items: { type: 'string' },
        description: 'Console levels to include, such as error, warn, info, log. Omit for every level.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          messages: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                msgid: { type: 'number', required: true },
                type: { type: 'string', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.messages.length === 0
          ? 'No console messages captured since this page attached.'
          : value.messages.map(message => `[${message.type}] ${message.text}`).join('\n'),
      }],
    },
    async execute(args) {
      const { page } = await resolveTarget(control, args.pageIdx)
      if (page === undefined) throw new Error('no page to read')
      const wanted = args.types === undefined || args.types.length === 0 ? undefined : new Set(args.types)
      const capture = await control.events(page.lease)
      requireDomains(capture, CONSOLE_DOMAINS)
      const messages = consoleMessagesOf(capture.events)
        .filter(message => wanted === undefined || wanted.has(message.type))
      return { messages: messages.slice(-pageSizeOf(args.pageSize)) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_network_requests',
    description: 'Inspect captured HTTP(S) traffic for a page of the built-in browser.',
    parameters: {
      pageIdx: { type: 'number', description: 'Page to read, as select_page lists it. Defaults to the only page.' },
      pageSize: { type: 'number', description: 'Maximum requests to return, newest last. Defaults to 20.' },
      urlFilter: { type: 'string', description: 'Return only requests whose URL contains this text.' },
      methods: {
        type: 'array', items: { type: 'string' },
        description: 'HTTP methods to include, such as GET or POST. Omit for every method.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          requests: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                reqid: { type: 'number', required: true },
                method: { type: 'string', required: true },
                url: { type: 'string', required: true },
                status: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.requests.length === 0
          ? 'No requests captured since this page attached; reload it to capture its load.'
          : value.requests.map(request => `${request.method} ${request.url} → ${request.status}`).join('\n'),
      }],
    },
    async execute(args) {
      const { page } = await resolveTarget(control, args.pageIdx)
      if (page === undefined) throw new Error('no page to read')
      const wanted = args.methods === undefined || args.methods.length === 0
        ? undefined
        : new Set(args.methods.map(method => method.toUpperCase()))
      const capture = await control.events(page.lease)
      requireDomains(capture, [NETWORK_DOMAIN])
      const requests = networkRequestsOf(capture.events).filter(request =>
        (args.urlFilter === undefined || request.url.includes(args.urlFilter))
        && (wanted === undefined || wanted.has(request.method)))
      return { requests: requests.slice(-pageSizeOf(args.pageSize)) }
    },
  }))
}

/** The domains a console listing reads. */
const CONSOLE_DOMAINS = ['Runtime.enable', 'Log.enable'] as const

/** The domain a traffic listing reads. */
const NETWORK_DOMAIN = 'Network.enable'

/**
 * Refuse a listing whose domain never started reporting.
 *
 * An empty list means "nothing happened yet"; a domain that would not enable means
 * "this page cannot tell you". The two must not look the same — and they did, until
 * the shell started carrying the reason.
 * @param capture - the page's capture.
 * @param domains - the domains this listing needs.
 * @throws when one refused, naming it and its reason.
 */
function requireDomains(capture: DesktopBrowserCapture, domains: readonly string[]): void {
  for (const domain of domains) {
    const refusal = capture.refused.find(entry => entry.domain === domain)
    if (refusal !== undefined) {
      throw new Error(`this page refused to report ${domain.replace('.enable', '')}: ${refusal.reason}`)
    }
  }
}

/** How many entries a listing returns when the caller names no size. */
function pageSizeOf(pageSize: number | undefined): number {
  return pageSize === undefined || pageSize <= 0 ? 20 : Math.min(pageSize, 200)
}

/** One console line, as the three protocol methods that carry them describe it. */
function consoleMessagesOf(events: readonly DesktopBrowserEvent[]): { msgid: number; type: string; text: string }[] {
  const messages: { msgid: number; type: string; text: string }[] = []
  for (const event of events) {
    const params = event.params as {
      type?: string
      args?: readonly { value?: unknown; description?: string }[]
      entry?: { level?: string; text?: string }
      exceptionDetails?: { exception?: { description?: string }; text?: string }
    }
    if (event.method === 'Runtime.consoleAPICalled') {
      const text = (params.args ?? []).map(argument =>
        typeof argument.value === 'string' ? argument.value : JSON.stringify(argument.value ?? argument.description ?? null)).join(' ')
      messages.push({ msgid: event.seq, type: params.type ?? 'log', text })
    } else if (event.method === 'Log.entryAdded') {
      messages.push({ msgid: event.seq, type: params.entry?.level ?? 'log', text: params.entry?.text ?? '' })
    } else if (event.method === 'Runtime.exceptionThrown') {
      messages.push({
        msgid: event.seq,
        type: 'error',
        text: params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'uncaught exception',
      })
    }
  }
  return messages
}

/** One request, merged from the events that announce it and report its outcome. */
function networkRequestsOf(
  events: readonly DesktopBrowserEvent[],
): { reqid: number; method: string; url: string; status: string }[] {
  const byRequest = new Map<string, { reqid: number; method: string; url: string; status: string }>()
  for (const event of events) {
    const params = event.params as {
      requestId?: string
      request?: { method?: string; url?: string }
      response?: { status?: number }
      errorText?: string
      type?: string
    }
    const id = params.requestId
    if (id === undefined) continue
    if (event.method === 'Network.requestWillBeSent') {
      byRequest.set(id, {
        reqid: event.seq,
        method: params.request?.method ?? 'GET',
        url: params.request?.url ?? '',
        status: 'pending',
      })
    } else if (event.method === 'Network.responseReceived') {
      const held = byRequest.get(id)
      if (held !== undefined) held.status = String(params.response?.status ?? '')
    } else if (event.method === 'Network.loadingFailed') {
      const held = byRequest.get(id)
      if (held !== undefined) held.status = `failed: ${params.errorText ?? 'unknown'}`
    }
  }
  return [...byRequest.values()]
}
