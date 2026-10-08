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

/** One captured page: the bytes, and whose they are. */
export interface CapturedPage {
  /** The page that produced the image. */
  readonly page: DesktopBrowserPage
  /** Its position within the candidate list that was offered. */
  readonly pageIdx: number
  /** The image bytes. */
  readonly image: Uint8Array
}

/**
 * Capture the first page that can actually be painted.
 *
 * A page whose tab is retained but not on screen keeps a 0×0 view and yields nothing.
 * That is a property of the layout, not of the page, and it is why a screenshot asked
 * for without naming a page must not simply take the first one: the first entry is
 * the OLDEST page, which is usually a tab that is not on screen at all. Naming no
 * page means "the browser area the user is looking at", so candidates are tried in
 * order and the first real image wins. Naming one keeps the strict reading: that
 * page, or a refusal that says why it could not be taken.
 * @param control - the bridge.
 * @param pages - the candidate pages, in the order `select_page` lists them.
 * @param format - `png`, or `jpeg` at the given quality.
 * @param quality - JPEG quality 0-100; ignored for png.
 * @returns the captured page and its bytes.
 * @throws with the last refusal when no candidate could be captured.
 */
export async function capturePainted(
  control: DesktopBrowserControl,
  pages: readonly DesktopBrowserPage[],
  format: 'png' | 'jpeg',
  quality: number | undefined,
): Promise<CapturedPage> {
  let refusal: string | undefined
  for (const [pageIdx, page] of pages.entries()) {
    try {
      const image = await control.screenshot(page.lease, format, quality)
      if (image.length > 0) return { page, pageIdx, image }
      refusal = 'the page produced an empty image'
    } catch (error: unknown) {
      refusal = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(refusal ?? 'no page to capture')
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
  // Request breakpoints this Host has set, per page. The protocol has no "list
  // breakpoints" call, so what a page was asked to break on is remembered here — and
  // forgotten with the registration, which is the same lifetime as the bridge.
  const xhrBreakpoints = new Map<string, Set<string>>()
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
      + 'Pass a function expression, for example "() => document.title". While the page is paused, pass '
      + 'callFrameIndex to evaluate inside that frame, reading its arguments and locals.',
    parameters: {
      function: { type: 'string', required: true, description: 'JavaScript function expression to evaluate.' },
      pageIdx: { type: 'number', description: 'Page to evaluate in, as select_page lists it. Defaults to the only page.' },
      callFrameIndex: {
        type: 'number',
        description: 'Frame to evaluate in, as get_paused_info lists them. Only while the page is paused.',
      },
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
      const expression = `(${args.function})()`
      // A paused page cannot answer `Runtime.evaluate` at all: it is stopped, and the
      // call would sit there until the tool's deadline. Asking the frame is the only way
      // to read a local, and it is what the caller asked for by naming one.
      const evaluation = args.callFrameIndex === undefined
        ? await control.command(page.lease, 'Runtime.evaluate', {
          expression, awaitPromise: true, returnByValue: true,
        }) as RuntimeEvaluation
        : await evaluateInFrame(control, page.lease, expression, args.callFrameIndex)
      if (evaluation.exceptionDetails !== undefined) {
        throw new Error(evaluation.exceptionDetails.exception?.description
          ?? evaluation.exceptionDetails.text ?? 'the page threw while evaluating')
      }
      const value = evaluation.result?.value
      return { value: typeof value === 'string' ? value : JSON.stringify(value ?? evaluation.result?.description ?? null) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'break_on_xhr',
    description: 'Pause a page of the built-in browser when it sends a request whose URL contains this text. '
      + 'The page stops at the request, and get_paused_info reports where.',
    parameters: {
      url: { type: 'string', required: true, description: 'URL substring to pause on.' },
      pageIdx: { type: 'number', description: 'Page to break in, as select_page lists it. Defaults to the only page.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { url: { type: 'string', required: true }, breakpoints: { type: 'array', required: true, items: { type: 'string' } } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Breaking on requests containing ${value.url}. Breakpoints: ${value.breakpoints.join(', ') || 'none'}`,
      }],
    },
    async execute(args) {
      const { page } = await resolveTarget(control, args.pageIdx)
      if (page === undefined) throw new Error('no page to break in')
      await control.command(page.lease, 'DOMDebugger.setXHRBreakpoint', { url: args.url })
      const set = xhrBreakpoints.get(page.lease) ?? new Set<string>()
      set.add(args.url)
      xhrBreakpoints.set(page.lease, set)
      return { url: args.url, breakpoints: [...set] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_breakpoints',
    description: 'List the request breakpoints set on a page of the built-in browser by break_on_xhr.',
    parameters: {
      pageIdx: { type: 'number', description: 'Page to read, as select_page lists it. Defaults to the only page.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { urls: { type: 'array', required: true, items: { type: 'string' } } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.urls.length === 0 ? 'No request breakpoints set.' : value.urls.join('\n'),
      }],
    },
    async execute(args) {
      const { page } = await resolveTarget(control, args.pageIdx)
      if (page === undefined) throw new Error('no page to read')
      return { urls: [...xhrBreakpoints.get(page.lease) ?? []] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'remove_breakpoint',
    description: 'Remove one request breakpoint set by break_on_xhr, or every one of them with all: true.',
    parameters: {
      url: { type: 'string', description: 'URL substring the breakpoint was set with.' },
      all: { type: 'boolean', description: 'Remove every request breakpoint on the page.' },
      pageIdx: { type: 'number', description: 'Page to change, as select_page lists it. Defaults to the only page.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { removed: { type: 'array', required: true, items: { type: 'string' } } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.removed.length === 0 ? 'Nothing was removed.' : `Removed ${value.removed.join(', ')}`,
      }],
    },
    async execute(args) {
      const { page } = await resolveTarget(control, args.pageIdx)
      if (page === undefined) throw new Error('no page to change')
      const set = xhrBreakpoints.get(page.lease) ?? new Set<string>()
      const removed = args.all === true ? [...set] : args.url === undefined ? [] : [args.url]
      if (removed.length === 0) throw new Error('name a url, or pass all: true')
      for (const url of removed) {
        await control.command(page.lease, 'DOMDebugger.removeXHRBreakpoint', { url })
        set.delete(url)
      }
      return { removed }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_paused_info',
    description: 'Report where a page of the built-in browser is paused, with its call frames and the breakpoints it '
      + 'hit, or that it is running. While a page is paused, only the tools that resume or step it can move it.',
    parameters: {
      pageIdx: { type: 'number', description: 'Page to read, as select_page lists it. Defaults to the only page.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          paused: { type: 'boolean', required: true },
          reason: { type: 'string', required: true },
          frames: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                index: { type: 'number', required: true },
                functionName: { type: 'string', required: true },
                url: { type: 'string', required: true },
                line: { type: 'number', required: true },
                column: { type: 'number', required: true },
              },
            },
          },
          hitBreakpoints: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.paused
          ? `Paused (${value.reason}) at\n${value.frames.map(frame =>
            `${String(frame.index)}: ${frame.functionName || '(anonymous)'} ${frame.url}:${String(frame.line)}:${String(frame.column)}`).join('\n')}`
            + `${value.hitBreakpoints.length === 0 ? '' : `\nHit: ${value.hitBreakpoints.join(', ')}`}`
          : 'The page is running.',
      }],
    },
    async execute(args) {
      const { page } = await resolveTarget(control, args.pageIdx)
      if (page === undefined) throw new Error('no page to read')
      const paused = pausedStateOf((await control.events(page.lease)).events)
      if (paused === undefined) {
        return { paused: false, reason: '', frames: [], hitBreakpoints: [] }
      }
      return {
        paused: true,
        reason: paused.reason,
        frames: paused.callFrames.map((frame, index) => ({
          index,
          functionName: frame.functionName ?? '',
          url: frame.url ?? '',
          // The protocol counts from 0; a caller reads a line as an editor shows it.
          line: (frame.location?.lineNumber ?? 0) + 1,
          column: (frame.location?.columnNumber ?? 0) + 1,
        })),
        hitBreakpoints: [...paused.hitBreakpoints],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'pause_or_resume',
    description: 'Pause a page of the built-in browser now, or let a paused one continue.',
    parameters: {
      action: { type: 'string', required: true, enum: ['pause', 'resume'], description: 'What to do to the page.' },
      pageIdx: { type: 'number', description: 'Page to act on, as select_page lists it. Defaults to the only page.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { paused: { type: 'boolean', required: true }, reason: { type: 'string', required: true } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.paused ? `Paused (${value.reason || 'pause requested'}).` : 'The page is running.',
      }],
    },
    async execute(args) {
      const { page } = await resolveTarget(control, args.pageIdx)
      if (page === undefined) throw new Error('no page to act on')
      if (args.action === 'pause') {
        await control.command(page.lease, 'Debugger.pause')
        // The pause arrives as an event, so the state is only true once one has landed.
        const paused = await waitForPause(control, page.lease, undefined)
        return { paused: paused !== undefined, reason: paused?.reason ?? '' }
      }
      await control.command(page.lease, 'Debugger.resume')
      const cleared = await waitForRunning(control, page.lease)
      return { paused: !cleared, reason: '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'step',
    description: 'Advance a paused page of the built-in browser by one statement, and report where it stopped next.',
    parameters: {
      direction: {
        type: 'string', required: true, enum: ['over', 'into', 'out'],
        description: 'over for the next statement, into to follow a call, out to finish the current function.',
      },
      pageIdx: { type: 'number', description: 'Page to step, as select_page lists it. Defaults to the only page.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          paused: { type: 'boolean', required: true },
          reason: { type: 'string', required: true },
          functionName: { type: 'string', required: true },
          url: { type: 'string', required: true },
          line: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.paused
          ? `Paused (${value.reason}) in ${value.functionName || '(anonymous)'} ${value.url}:${String(value.line)}`
          : 'The page is running.',
      }],
    },
    async execute(args) {
      const { page } = await resolveTarget(control, args.pageIdx)
      if (page === undefined) throw new Error('no page to step')
      const before = pausedStateOf((await control.events(page.lease)).events)
      if (before === undefined) throw new Error('the page is not paused: pause it or set a breakpoint first')
      const method = args.direction === 'into'
        ? 'Debugger.stepInto'
        : args.direction === 'out' ? 'Debugger.stepOut' : 'Debugger.stepOver'
      await control.command(page.lease, method)
      // A step answers at once and pauses again as an event, so the new stop is waited
      // for: reporting the frame the caller just left would be worse than waiting.
      const paused = await waitForPause(control, page.lease, before.sequence)
      if (paused === undefined) return { paused: false, reason: '', functionName: '', url: '', line: 0 }
      const frame = paused.callFrames[0]
      return {
        paused: true,
        reason: paused.reason,
        functionName: frame?.functionName ?? '',
        url: frame?.url ?? '',
        line: (frame?.location?.lineNumber ?? 0) + 1,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'click_element',
    description: 'Click one element in a page of the built-in browser. The selector must match exactly one element '
      + 'unless index names which match. The element must be painted. A click can submit data or navigate, so it '
      + 'requires confirm: true.',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector, resolved in the page.' },
      index: { type: 'number', description: 'Zero-based match to click when the selector matches several.' },
      confirm: { type: 'boolean', required: true, description: 'Must be true to authorize this click.' },
      pageIdx: { type: 'number', description: 'Page to click in, as select_page lists it. Defaults to the only page.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          clicked: { type: 'string', required: true },
          x: { type: 'number', required: true },
          y: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Clicked ${value.clicked} at ${String(value.x)},${String(value.y)}.`,
      }],
    },
    async execute(args) {
      if (args.confirm !== true) throw new Error('a click can submit data or navigate: pass confirm: true')
      const { page } = await resolveTarget(control, args.pageIdx)
      if (page === undefined) throw new Error('no page to click in')
      const resolution = await control.command(page.lease, 'Runtime.evaluate', {
        expression: resolveClickExpression(args.selector, args.index),
        returnByValue: true,
      }) as { result?: { value?: ClickResolution } }
      const found = resolution.result?.value
      if (found?.ok !== true) throw new Error(found?.reason ?? 'the click target could not be resolved')
      const x = found.x ?? 0
      const y = found.y ?? 0
      // The protocol's own mouse events rather than a synthesized `click()`: a page that
      // listens for pointer input — a canvas grid, a drag handle — never sees the latter.
      await control.command(page.lease, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 1,
      })
      await control.command(page.lease, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
      })
      return { clicked: found.description ?? args.selector, x, y }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'clear_network_requests',
    description: 'Discard the console, traffic, script and WebSocket events captured for a page of the built-in '
      + 'browser, so a listing afterwards shows only what happens next. This clears captured evidence, not cookies '
      + 'or storage.',
    parameters: {
      pageIdx: { type: 'number', description: 'Page to clear, as select_page lists it. Defaults to the only page.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { removed: { type: 'number', required: true } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Discarded ${String(value.removed)} captured events.`,
      }],
    },
    async execute(args) {
      const { page } = await resolveTarget(control, args.pageIdx)
      if (page === undefined) throw new Error('no page to clear')
      return { removed: await control.clearEvents(page.lease) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'clear_site_data',
    description: 'Clear the cookies and storage a page of the built-in browser keeps, and optionally its caches. '
      + 'Irreversible, and the page is NOT reloaded, so what it holds in memory stays until it navigates. '
      + 'Only this sidebar browser is affected, and only the workspace partition behind it.',
    parameters: {
      pageIdx: { type: 'number', description: 'Page to clear, as select_page lists it. Defaults to the only page.' },
      browserCache: { type: 'boolean', description: 'Also drop the HTTP cache and cached host lookups.' },
      confirm: { type: 'boolean', required: true, description: 'Must be true to authorize clearing site data.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          browserCache: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Cleared cookies and storage for ${value.url}`
          + `${value.browserCache ? ', plus the HTTP and host-lookup caches' : ''}. The page was not reloaded.`,
      }],
    },
    async execute(args) {
      if (args.confirm !== true) throw new Error('clearing site data is irreversible: pass confirm: true')
      const { page } = await resolveTarget(control, args.pageIdx)
      if (page === undefined) throw new Error('no page to clear')
      await control.clearSiteData(page.lease, args.browserCache === true)
      return { url: page.url, browserCache: args.browserCache === true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'new_page',
    description: 'Open a new page in the built-in browser and return it, so it can be driven. '
      + 'Use this when no page is open, or to visit another address beside the one already showing.',
    parameters: {
      url: { type: 'string', required: true, description: 'The absolute http(s) address to open.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          pageIdx: { type: 'number', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Opened ${value.url} as page ${String(value.pageIdx)}: ${value.title}`,
      }],
    },
    async execute(args) {
      if (!/^https?:\/\//i.test(args.url)) {
        throw new Error('url must be an absolute http or https address')
      }
      const page = await control.newPage(args.url)
      if (page === undefined) {
        throw new Error('the built-in browser did not open a page: is the right sidebar available?')
      }
      // Reported last, so the position it names is the one a following call will find.
      const pages = await control.list()
      const pageIdx = pages.findIndex(candidate => candidate.lease === page.lease)
      return { pageIdx: pageIdx < 0 ? 0 : pageIdx, url: page.url, title: page.title }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_websocket_messages',
    description: 'Inspect the WebSocket connections a page of the built-in browser opened, and their frames. '
      + 'Without wsid it lists the connections; with wsid it lists that connection\'s frames, oldest first. '
      + 'Note pageIdx here names the browser PAGE, as in every tool of this set; frameIdx pages the frames.',
    parameters: {
      pageIdx: { type: 'number', description: 'Page to read, as select_page lists it. Defaults to the only page.' },
      wsid: { type: 'number', description: 'Connection to read, as the listing names it. Omit to list connections.' },
      urlFilter: { type: 'string', description: 'List only connections whose URL contains this text.' },
      direction: { type: 'string', enum: ['sent', 'received'], description: 'Only frames the page sent, or only those it received.' },
      frameIdx: { type: 'number', description: 'Zero-based first frame to return. Defaults to the oldest.' },
      frameIndex: { type: 'number', description: 'Return one frame by the index the listing shows, instead of a range.' },
      pageSize: { type: 'number', description: 'Maximum frames to return. Defaults to 20.' },
      showContent: { type: 'boolean', description: 'Include each frame\'s payload. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          connections: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                wsid: { type: 'number', required: true },
                url: { type: 'string', required: true },
                closed: { type: 'boolean', required: true },
              },
            },
          },
          frames: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                index: { type: 'number', required: true },
                wsid: { type: 'number', required: true },
                direction: { type: 'string', required: true },
                opcode: { type: 'number', required: true },
                length: { type: 'number', required: true },
                content: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.connections.length > 0
          ? value.connections.map(socket => `wsid ${String(socket.wsid)} ${socket.closed ? '(closed)' : '(open)'} ${socket.url}`).join('\n')
          : value.frames.length > 0
            ? value.frames.map(frame => `${String(frame.index)} ${frame.direction} ${String(frame.length)}B`
              + `${frame.content === undefined ? '' : ` ${frame.content}`}`).join('\n')
            : 'No WebSocket traffic captured since this page attached; reload it to capture its load.',
      }],
    },
    async execute(args) {
      const { page } = await resolveTarget(control, args.pageIdx)
      if (page === undefined) throw new Error('no page to read')
      const capture = await control.events(page.lease)
      requireDomains(capture, [NETWORK_DOMAIN])
      const connections = socketsOf(capture.events)
      if (args.wsid === undefined) {
        return {
          connections: connections
            .filter(socket => args.urlFilter === undefined || socket.url.includes(args.urlFilter))
            .map(socket => ({ wsid: socket.wsid, url: socket.url, closed: socket.closed })),
          frames: [],
        }
      }
      const all = framesOf(capture.events, connections)
        .filter(frame => frame.wsid === args.wsid)
        .filter(frame => args.direction === undefined || frame.direction === args.direction)
      const chosen = args.frameIndex === undefined
        ? all.slice(args.frameIdx ?? 0, (args.frameIdx ?? 0) + pageSizeOf(args.pageSize))
        : all.filter(frame => frame.index === args.frameIndex)
      return {
        connections: [],
        frames: chosen.map(frame => ({
          index: frame.index,
          wsid: frame.wsid,
          direction: frame.direction,
          opcode: frame.opcode,
          length: frame.payload.length,
          ...args.showContent === true ? { content: frame.payload.slice(0, 10_000) } : {},
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'take_screenshot',
    description: 'Capture a page of the built-in browser as an image, save it to a file, and return the path. '
      + 'Read the file back with read_image to look at it. Without pageIdx it captures the browser area that is '
      + 'on screen, which is what visual verification wants; with pageIdx it captures exactly that page.',
    parameters: {
      pageIdx: { type: 'number', description: 'Page to capture, as select_page lists it. Defaults to the page on screen.' },
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
          url: { type: 'string', required: true },
          pageIdx: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Saved a ${String(value.bytes)}-byte screenshot of ${value.url} (pageIdx ${String(value.pageIdx)}) to `
          + `${value.path}. Read it with read_image.`,
      }],
    },
    async execute(args) {
      const format = args.format ?? 'png'
      const encoded = format === 'jpeg' ? 'jpeg' : 'png'
      const pages = await control.list()
      if (pages.length === 0) {
        throw new Error('no page is open in the built-in browser: open one in the right sidebar first')
      }
      const candidates = args.pageIdx === undefined ? pages : pages.slice(args.pageIdx, args.pageIdx + 1)
      if (candidates.length === 0) {
        throw new Error(`no page at pageIdx ${String(args.pageIdx)}: ${String(pages.length)} are open`)
      }
      // Electron captures a guest; the protocol's own screenshot does not answer for
      // one, which three live attempts reported as a shell that never replied.
      const captured = await capturePainted(control, candidates, encoded, args.quality)
      const path = args.filePath ?? join(tmpdir(), `dsh-browser-${String(Date.now())}.${encoded === 'jpeg' ? 'jpg' : 'png'}`)
      const target = await ctx.fs.resolve(path)
      await ctx.fs.writeBytes(target, captured.image)
      return {
        path,
        bytes: captured.image.length,
        url: captured.page.url,
        pageIdx: args.pageIdx ?? captured.pageIdx,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_scripts',
    description: 'List the scripts a page of the built-in browser has loaded, with the ids used to read them. '
      + 'Ids expire when the page reloads or navigates.',
    parameters: {
      pageIdx: { type: 'number', description: 'Page to read, as select_page lists it. Defaults to the only page.' },
      urlFilter: { type: 'string', description: 'Return only scripts whose URL contains this text.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          scripts: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                scriptId: { type: 'string', required: true },
                url: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.scripts.length === 0
          ? 'No scripts captured since this page attached; reload it to capture its load.'
          : value.scripts.map(script => `${script.scriptId} ${script.url}`).join('\n'),
      }],
    },
    async execute(args) {
      const { page } = await resolveTarget(control, args.pageIdx)
      if (page === undefined) throw new Error('no page to read')
      const capture = await control.events(page.lease)
      requireDomains(capture, ['Debugger.enable'])
      const scripts = scriptsOf(capture.events)
        .filter(script => args.urlFilter === undefined || script.url.includes(args.urlFilter))
      return { scripts }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_script_source',
    description: 'Read a script a page of the built-in browser loaded. Select it by url or scriptId, and narrow '
      + 'the read with line ranges, or with offset and length for minified single-line code.',
    parameters: {
      pageIdx: { type: 'number', description: 'Page to read, as select_page lists it. Defaults to the only page.' },
      scriptId: { type: 'string', description: 'Script id from list_scripts. Preferred only within one page life.' },
      url: { type: 'string', description: 'Script URL or a unique substring of it; the preferred selector.' },
      startLine: { type: 'number', description: '1-based first line to return.' },
      endLine: { type: 'number', description: 'Inclusive last line to return.' },
      offset: { type: 'number', description: 'Zero-based character offset into the source.' },
      length: { type: 'number', description: 'Maximum characters to return from offset. Defaults to 1000.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `// ${value.url}\n${value.text}` }],
    },
    async execute(args) {
      const { page } = await resolveTarget(control, args.pageIdx)
      if (page === undefined) throw new Error('no page to read')
      const scripts = scriptsOf((await control.events(page.lease)).events)
      const script = args.scriptId !== undefined
        ? scripts.find(candidate => candidate.scriptId === args.scriptId)
        : scripts.find(candidate => candidate.url.includes(args.url ?? ''))
      if (script === undefined) {
        throw new Error(`no script matches ${args.scriptId ?? args.url ?? ''}: list_scripts names the ones this page loaded`)
      }
      const source = await control.command(page.lease, 'Debugger.getScriptSource', { scriptId: script.scriptId }) as { scriptSource?: string }
      const full = source.scriptSource ?? ''
      if (args.offset !== undefined) {
        return { url: script.url, text: full.slice(args.offset, args.offset + (args.length ?? 1_000)) }
      }
      if (args.startLine === undefined && args.endLine === undefined) return { url: script.url, text: full }
      // The protocol counts lines from 0; the tool counts from 1 like every editor.
      const lines = full.split('\n')
      const from = Math.max(0, (args.startLine ?? 1) - 1)
      const to = Math.min(lines.length, args.endLine ?? lines.length)
      return { url: script.url, text: lines.slice(from, to).join('\n') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'search_in_sources',
    description: 'Search the scripts a page of the built-in browser loaded for text or a regular expression, '
      + 'and return the matching lines.',
    parameters: {
      pageIdx: { type: 'number', description: 'Page to read, as select_page lists it. Defaults to the only page.' },
      query: { type: 'string', required: true, description: 'Text to find, or a regular expression when isRegex is true.' },
      isRegex: { type: 'boolean', description: 'Interpret query as a regular expression. Defaults to false.' },
      urlFilter: { type: 'string', description: 'Search only scripts whose URL contains this text.' },
      maxResults: { type: 'number', description: 'Maximum matches to return. Defaults to 30.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          matches: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                url: { type: 'string', required: true },
                line: { type: 'number', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.matches.length === 0
          ? 'No match in the scripts this page loaded.'
          : value.matches.map(match => `${match.url}:${String(match.line)} ${match.text}`).join('\n'),
      }],
    },
    async execute(args) {
      const { page } = await resolveTarget(control, args.pageIdx)
      if (page === undefined) throw new Error('no page to read')
      const wanted = args.maxResults === undefined || args.maxResults <= 0 ? 30 : Math.min(args.maxResults, 200)
      const scripts = scriptsOf((await control.events(page.lease)).events)
        .filter(script => script.url !== '' && (args.urlFilter === undefined || script.url.includes(args.urlFilter)))
      // A regex the caller cannot compile is their error, not a silent no-match.
      const pattern = args.isRegex === true
        ? new RegExp(args.query, 'u')
        : undefined
      const matches: { url: string; line: number; text: string }[] = []
      for (const script of scripts) {
        if (matches.length >= wanted) break
        const source = await control.command(page.lease, 'Debugger.getScriptSource', { scriptId: script.scriptId }) as { scriptSource?: string }
        const lines = (source.scriptSource ?? '').split('\n')
        for (const [index, text] of lines.entries()) {
          const hit = pattern === undefined ? text.includes(args.query) : pattern.test(text)
          if (!hit) continue
          matches.push({ url: script.url, line: index + 1, text: text.slice(0, 200) })
          if (matches.length >= wanted) break
        }
      }
      return { matches }
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

/** One WebSocket a page opened, as the protocol announced it. */
export interface CapturedSocket {
  /** The socket's position in the page's lifetime, and what `wsid` names. */
  readonly wsid: number
  readonly requestId: string
  readonly url: string
  readonly closed: boolean
}

/**
 * The sockets a page opened, numbered in the order it opened them.
 *
 * Numbering here rather than reusing the protocol's `requestId` is what makes a `wsid`
 * stable across two calls: an agent lists the connections and then asks about one of
 * them, and the protocol's own identifier is not something a listing can show.
 * @param events - the page's captured events.
 * @returns one entry per socket, oldest first.
 */
export function socketsOf(events: readonly DesktopBrowserEvent[]): CapturedSocket[] {
  const sockets: CapturedSocket[] = []
  const byRequest = new Map<string, CapturedSocket>()
  for (const event of events) {
    const params = event.params as { requestId?: string; url?: string; response?: { url?: string } }
    const requestId = params.requestId
    if (requestId === undefined) continue
    if (event.method === 'Network.webSocketCreated') {
      const socket: CapturedSocket = {
        wsid: sockets.length + 1,
        requestId,
        url: params.url ?? '',
        closed: false,
      }
      sockets.push(socket)
      byRequest.set(requestId, socket)
    } else if (event.method === 'Network.webSocketClosed') {
      const socket = byRequest.get(requestId)
      if (socket !== undefined) sockets[sockets.indexOf(socket)] = { ...socket, closed: true }
    }
  }
  return sockets
}

/** One frame a socket carried, in the order the page exchanged it. */
export interface CapturedFrame {
  readonly index: number
  readonly wsid: number
  readonly direction: 'sent' | 'received'
  readonly opcode: number
  readonly payload: string
}

/**
 * Every frame the page's sockets carried, in exchange order.
 * @param events - the page's captured events.
 * @param sockets - the sockets those frames belong to.
 * @returns one entry per frame, oldest first.
 */
export function framesOf(events: readonly DesktopBrowserEvent[], sockets: readonly CapturedSocket[]): CapturedFrame[] {
  const frames: CapturedFrame[] = []
  for (const event of events) {
    const sent = event.method === 'Network.webSocketFrameSent'
    if (!sent && event.method !== 'Network.webSocketFrameReceived') continue
    const params = event.params as { requestId?: string; response?: { opcode?: number; payloadData?: string } }
    const socket = sockets.find(candidate => candidate.requestId === params.requestId)
    if (socket === undefined) continue
    frames.push({
      index: frames.length + 1,
      wsid: socket.wsid,
      direction: sent ? 'sent' : 'received',
      opcode: params.response?.opcode ?? 1,
      payload: params.response?.payloadData ?? '',
    })
  }
  return frames
}

/** The scripts a page announced, in the order the protocol reported them. */
function scriptsOf(events: readonly DesktopBrowserEvent[]): { scriptId: string; url: string }[] {
  return events
    .filter(event => event.method === 'Debugger.scriptParsed')
    .map((event) => {
      const params = event.params as { scriptId?: string; url?: string }
      return { scriptId: params.scriptId ?? '', url: params.url ?? '' }
    })
    .filter(script => script.scriptId !== '')
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

/** One call frame of a paused page, as far as these tools read it. */
interface PausedFrame {
  readonly functionName?: string
  readonly url?: string
  readonly location?: { readonly lineNumber?: number; readonly columnNumber?: number }
  readonly callFrameId?: string
}

/** Where a page stopped, and how far into its life that happened. */
export interface PausedState {
  /** The event sequence the pause arrived at, so a later stop is told from it. */
  readonly sequence: number
  readonly reason: string
  readonly callFrames: readonly PausedFrame[]
  readonly hitBreakpoints: readonly string[]
}

/**
 * Whether the page is paused, replayed from what capture holds.
 *
 * A pause and its resume are both events, so the state is whichever came last. Replaying
 * is also the only way to ask: a stopped page cannot answer `Runtime.evaluate`, which is
 * why the pause family is built on the log rather than on a query.
 * @param events - the page's captured events.
 * @returns the current stop, or undefined when the page is running.
 */
export function pausedStateOf(events: readonly DesktopBrowserEvent[]): PausedState | undefined {
  let paused: PausedState | undefined
  for (const event of events) {
    if (event.method === 'Debugger.paused') {
      const params = event.params as {
        reason?: string
        callFrames?: readonly PausedFrame[]
        hitBreakpoints?: readonly string[]
      }
      paused = {
        sequence: event.seq,
        reason: params.reason ?? '',
        callFrames: params.callFrames ?? [],
        hitBreakpoints: params.hitBreakpoints ?? [],
      }
    } else if (event.method === 'Debugger.resumed') {
      paused = undefined
    }
  }
  return paused
}

/** How long a stop is waited for after asking for one. */
const PAUSE_DEADLINE_MS = 5_000
const PAUSE_POLL_MS = 60

/**
 * Wait for the page to be paused at a stop later than one already seen.
 * @param control - the bridge.
 * @param lease - the page.
 * @param since - the sequence of the stop already seen, or undefined for any stop.
 * @returns the stop, or undefined when none arrived in time.
 */
async function waitForPause(
  control: DesktopBrowserControl, lease: string, since: number | undefined,
): Promise<PausedState | undefined> {
  const deadline = Date.now() + PAUSE_DEADLINE_MS
  while (Date.now() < deadline) {
    const paused = pausedStateOf((await control.events(lease)).events)
    if (paused !== undefined && (since === undefined || paused.sequence > since)) return paused
    await new Promise(resolve => setTimeout(resolve, PAUSE_POLL_MS))
  }
  return undefined
}

/**
 * Wait for a resumed page to report itself running.
 * @param control - the bridge.
 * @param lease - the page.
 * @returns true when it is running, false when the deadline passed first.
 */
async function waitForRunning(control: DesktopBrowserControl, lease: string): Promise<boolean> {
  const deadline = Date.now() + PAUSE_DEADLINE_MS
  while (Date.now() < deadline) {
    if (pausedStateOf((await control.events(lease)).events) === undefined) return true
    await new Promise(resolve => setTimeout(resolve, PAUSE_POLL_MS))
  }
  return false
}

/**
 * Evaluate an expression inside one call frame of a paused page.
 * @param control - the bridge.
 * @param lease - the page.
 * @param expression - the expression to evaluate.
 * @param index - the frame, as `get_paused_info` lists it.
 * @returns the evaluation, in the shape the callers already read.
 * @throws when the page is not paused, or has no frame at that index.
 */
async function evaluateInFrame(
  control: DesktopBrowserControl, lease: string, expression: string, index: number,
): Promise<RuntimeEvaluation> {
  const paused = pausedStateOf((await control.events(lease)).events)
  if (paused === undefined) throw new Error('the page is not paused: callFrameIndex needs a stopped frame')
  const frame = paused.callFrames[index]
  if (frame?.callFrameId === undefined) {
    throw new Error(`no call frame at index ${String(index)}: get_paused_info lists ${String(paused.callFrames.length)}`)
  }
  return await control.command(lease, 'Debugger.evaluateOnCallFrame', {
    callFrameId: frame.callFrameId,
    expression,
    returnByValue: true,
  }) as RuntimeEvaluation
}

/** What one click resolution reports, as far as this tool reads it. */
export interface ClickResolution {
  readonly ok: boolean
  readonly reason?: string
  readonly x?: number
  readonly y?: number
  readonly description?: string
}

/**
 * The expression that resolves one click target.
 *
 * It answers rather than throws, because each way it can fail is something the caller
 * has to read and act on differently: a selector that matches nothing, one that matches
 * several without an index, and an element that is present but not painted are three
 * different mistakes with three different fixes. Coordinates come back as viewport CSS
 * pixels, which is the space the protocol's mouse events take — and the element is
 * scrolled into view first, so a target below the fold is still clickable.
 * @param selector - the CSS selector to resolve.
 * @param index - the match to use when several match.
 * @returns an expression for `Runtime.evaluate`, resolving to a `ClickResolution`.
 */
export function resolveClickExpression(selector: string, index: number | undefined): string {
  return `(() => {
  const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
  if (all.length === 0) return { ok: false, reason: 'nothing matches that selector' };
  const index = ${index === undefined ? 'undefined' : String(index)};
  if (index === undefined && all.length > 1) {
    return { ok: false, reason: 'the selector matches ' + all.length + ' elements: pass index' };
  }
  const element = all[index ?? 0];
  if (element === undefined) return { ok: false, reason: 'no element at that index: ' + all.length + ' match' };
  // Guarded because the answer still matters where scrolling is not implemented: a test
  // environment lays nothing out, and the coordinates are what the caller came for.
  if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden' || style.display === 'none'
    || Number(style.opacity) === 0) {
    return { ok: false, reason: 'the element is present but not painted' };
  }
  const text = (element.textContent ?? '').trim().slice(0, 60);
  return {
    ok: true,
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    description: element.tagName.toLowerCase() + (element.id === '' ? '' : '#' + element.id) + (text === '' ? '' : ' ' + text),
  };
})()`
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
