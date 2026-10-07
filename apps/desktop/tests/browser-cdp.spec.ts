/**
 * The shell's message guard, which decides what the Host may ask for. Getting this
 * wrong is expensive in a specific way: an unrecognised Host message is treated as
 * a protocol violation and the shell KILLS the Host it came from, so a request that
 * should have been accepted hangs the tool that sent it and takes the whole kernel
 * with it. That is exactly what a first event read did.
 */
import { describe, expect, it } from 'vitest'
import { isDesktopBrowserCommandRequest } from '../src/browser-cdp.ts'

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
    expect(isDesktopBrowserCommandRequest('nope')).toBe(false)
    expect(isDesktopBrowserCommandRequest(null)).toBe(false)
  })
})
