/**
 * The Host's end of the browser bridge: one request, one correlated reply, and a
 * deadline — a stalled shell must fail the tool that asked rather than hang it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installDesktopBrowserControl } from '../src/browser-cdp.ts'
import type { DesktopBrowserControl } from '../src/browser-cdp.ts'

const originalSend = process.send
const originalConnected = process.connected

afterEach(() => {
  Object.defineProperty(process, 'send', { value: originalSend, configurable: true, writable: true })
  Object.defineProperty(process, 'connected', { value: originalConnected, configurable: true })
  vi.useRealTimers()
})

/** Capture what the control sends, standing in for the shell's channel. */
function capture(): Record<string, unknown>[] {
  const sent: Record<string, unknown>[] = []
  Object.defineProperty(process, 'connected', { value: true, configurable: true })
  const send = (message: object, callback?: (error: Error | null) => void): boolean => {
    sent.push(message as Record<string, unknown>)
    callback?.(null)
    return true
  }
  Object.defineProperty(process, 'send', { value: send, configurable: true, writable: true })
  return sent
}

/** Answer one captured request the way the shell would. */
function answer(control: DesktopBrowserControl, request: Record<string, unknown>, payload: object): void {
  control.handle({ type: 'browser-command', requestId: request.requestId, ...payload })
}

describe('installDesktopBrowserControl', () => {
  it('correlates a page listing with its reply', async () => {
    const control = installDesktopBrowserControl()
    const sent = capture()
    const pages = control.list()
    const request = sent[0]!
    expect(request.type).toBe('browser-command')
    expect(request.lease).toBeUndefined()
    answer(control, request, { pages: [{ lease: 'l1', url: 'https://example.com/', title: 'Example' }] })
    await expect(pages).resolves.toEqual([{ lease: 'l1', url: 'https://example.com/', title: 'Example' }])
  })

  it('sends a command with its method and parameters, and returns the result', async () => {
    const control = installDesktopBrowserControl()
    const sent = capture()
    const value = control.command('l1', 'Runtime.evaluate', { expression: '1' })
    const request = sent[0]!
    expect(request).toMatchObject({ lease: 'l1', method: 'Runtime.evaluate', params: { expression: '1' } })
    answer(control, request, { result: { value: 1 } })
    await expect(value).resolves.toEqual({ value: 1 })
  })

  it('reports a shell failure as the command\'s error', async () => {
    const control = installDesktopBrowserControl()
    const sent = capture()
    const value = control.command('l1', 'Page.reload')
    answer(control, sent[0]!, { error: 'no live guest holds that lease' })
    await expect(value).rejects.toThrow('no live guest holds that lease')
  })

  it('fails a command the shell never answers', async () => {
    vi.useFakeTimers()
    const control = installDesktopBrowserControl(1_000)
    capture()
    const value = control.command('l1', 'Page.reload')
    const failure = expect(value).rejects.toThrow('did not answer in time')
    await vi.advanceTimersByTimeAsync(1_001)
    await failure
  })

  it('claims its own replies and leaves other messages alone', () => {
    const control = installDesktopBrowserControl()
    capture()
    // A reply nobody waits on is still this bridge's message, not a protocol error.
    expect(control.handle({ type: 'browser-command', requestId: 99 })).toBe(true)
    expect(control.handle({ type: 'shutdown' })).toBe(false)
    expect(control.handle('not a message')).toBe(false)
  })
})
