/**
 * The shell's message guard, which decides what the Host may ask for. Getting this
 * wrong is expensive in a specific way: an unrecognised Host message is treated as
 * a protocol violation and the shell KILLS the Host it came from, so a request that
 * should have been accepted hangs the tool that sent it and takes the whole kernel
 * with it. That is exactly what a first event read did.
 */
import { describe, expect, it, vi } from 'vitest'
import { answerBrowserCommand, isDesktopBrowserCommandRequest } from '../src/browser-cdp.ts'
import type { DesktopBrowserGuests } from '../src/browser-guests.ts'

describe('isDesktopBrowserCommandRequest', () => {
  it('accepts a listing, a command, and an event read with or without a resume point', () => {
    expect(isDesktopBrowserCommandRequest({ type: 'browser-command', requestId: 1 })).toBe(true)
    expect(isDesktopBrowserCommandRequest({
      type: 'browser-command', requestId: 1, lease: 'l', method: 'Page.reload',
    })).toBe(true)
    // The first event read has nothing to resume from. Requiring the sequence made
    // every first read invalid, and the shell answers invalid messages by killing
    // the Host.
    expect(isDesktopBrowserCommandRequest({ type: 'browser-command', requestId: 1, lease: 'l' })).toBe(true)
    expect(isDesktopBrowserCommandRequest({
      type: 'browser-command', requestId: 1, lease: 'l', eventsSince: 3,
    })).toBe(true)
  })

  it('refuses a message that is not one, or is malformed', () => {
    expect(isDesktopBrowserCommandRequest({ type: 'ready', url: 'u' })).toBe(false)
    expect(isDesktopBrowserCommandRequest({ type: 'browser-command' })).toBe(false)
    expect(isDesktopBrowserCommandRequest({ type: 'browser-command', requestId: 1, lease: 2 })).toBe(false)
    expect(isDesktopBrowserCommandRequest({ type: 'browser-command', requestId: 1, method: 'Page.reload' })).toBe(false)
    expect(isDesktopBrowserCommandRequest({ type: 'browser-command', requestId: 1, lease: 'l', eventsSince: 1.5 })).toBe(false)
    // Opening a page is the one request that carries no lease — there is nothing to
    // address yet — so it must be recognised before the lease rule refuses it.
    expect(isDesktopBrowserCommandRequest({
      type: 'browser-command', requestId: 1, newPage: { url: 'https://example.com/' },
    })).toBe(true)
    expect(isDesktopBrowserCommandRequest({
      type: 'browser-command', requestId: 1, newPage: { url: 'file:///etc/passwd' },
    })).toBe(false)
    expect(isDesktopBrowserCommandRequest({ type: 'browser-command', requestId: 1, newPage: {} })).toBe(false)
    expect(isDesktopBrowserCommandRequest({
      type: 'browser-command', requestId: 1, newPage: 'https://example.com/',
    })).toBe(false)
    expect(isDesktopBrowserCommandRequest('nope')).toBe(false)
    expect(isDesktopBrowserCommandRequest(null)).toBe(false)
  })
})

/**
 * Which branch a request takes. A screenshot carries a lease and no method, exactly
 * like an event read, so the order of those two tests decides whether a capture ever
 * runs: with the event read first, every screenshot answered with an empty event log
 * and the Host reported "the shell returned no image" — a message about an image that
 * was never taken. Three live attempts were spent on that message.
 */
describe('answerBrowserCommand', () => {
  const guests = (shot?: () => Promise<Uint8Array>): DesktopBrowserGuests => ({
    list: () => [{ lease: 'l1', url: 'https://example.com/', title: 'Example' }],
    events: () => ({ events: [], refused: [] }),
    screenshot: shot ?? (() => Promise.resolve(new Uint8Array([1, 2, 3]))),
    newPage: () => Promise.resolve({ lease: 'l2', url: 'https://example.com/', title: 'Example' }),
  }) as unknown as DesktopBrowserGuests

  it('captures a screenshot request instead of reading the event log', async () => {
    const shot = vi.fn(() => Promise.resolve(new Uint8Array([137, 80, 78, 71])))
    const sent: object[] = []
    await answerBrowserCommand(guests(shot), {
      type: 'browser-command', requestId: 7, lease: 'l1', screenshot: { format: 'png' },
    }, (message) => { sent.push(message) })
    expect(shot).toHaveBeenCalledWith('l1', 'png', undefined)
    expect(sent).toEqual([{
      type: 'browser-command', requestId: 7, data: Buffer.from([137, 80, 78, 71]).toString('base64'), format: 'png',
    }])
  })

  it('still reads the event log when no screenshot was asked for', async () => {
    const shot = vi.fn(() => Promise.resolve(new Uint8Array([1])))
    const sent: object[] = []
    await answerBrowserCommand(guests(shot), {
      type: 'browser-command', requestId: 8, lease: 'l1', eventsSince: 3,
    }, (message) => { sent.push(message) })
    expect(shot).not.toHaveBeenCalled()
    expect(sent).toEqual([{ type: 'browser-command', requestId: 8, events: [], refused: [] }])
  })

  it('opens a page when one is asked for, before any lease rule can refuse it', async () => {
    const sent: object[] = []
    await answerBrowserCommand(guests(), {
      type: 'browser-command', requestId: 9, newPage: { url: 'https://example.com/' },
    }, (message) => { sent.push(message) })
    expect(sent).toEqual([{
      type: 'browser-command', requestId: 9, page: { lease: 'l2', url: 'https://example.com/', title: 'Example' },
    }])
  })
})
