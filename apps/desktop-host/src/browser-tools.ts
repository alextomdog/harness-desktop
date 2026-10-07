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
import type { DesktopBrowserControl, DesktopBrowserPage } from './browser-cdp.ts'

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

/**
 * Register the built-in browser tools.
 * @param ctx - the plugin context carrying the tool registry.
 * @param control - the shell bridge.
 */
export function applyBrowserTools(ctx: Context, control: DesktopBrowserControl): void {
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
        properties: { url: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `Navigated to ${value.url}` }],
    },
    async execute(args) {
      const { page } = await resolveTarget(control, args.pageIdx)
      if (page === undefined) throw new Error('no page to navigate')
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
      // The guest's URL is the truthful answer: a redirect is not the url we asked for.
      const pages = await control.list()
      const landed = pages.find(candidate => candidate.lease === page.lease)
      return { url: landed?.url ?? args.url ?? page.url }
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
}
