/**
 * Which page a screenshot actually captures.
 *
 * The first version took whatever `pageIdx` the caller named, and the live result was
 * an honest refusal: the oldest page is usually a retained tab that is not on screen,
 * so its view is 0×0 and there is nothing to paint. "Screenshot the browser area" has
 * to mean the area that is on screen, which is a property only the capture itself can
 * report — so candidates are tried in order and the first real image wins.
 */
import { describe, expect, it, vi } from 'vitest'
import { capturePainted } from '../src/browser-tools.ts'
import type { DesktopBrowserControl, DesktopBrowserPage } from '../src/browser-cdp.ts'

const page = (lease: string, url: string): DesktopBrowserPage => ({ lease, url, title: url })

const control = (shot: (lease: string) => Promise<Uint8Array>): DesktopBrowserControl => ({
  list: () => Promise.resolve([]),
  command: () => Promise.resolve(null),
  events: () => Promise.resolve({ events: [], refused: [] }),
  screenshot: (lease: string) => shot(lease),
  handle: () => false,
}) as unknown as DesktopBrowserControl

describe('capturePainted', () => {
  it('captures the first page that can be painted, not the first page', async () => {
    const shot = vi.fn((lease: string) => lease === 'hidden'
      ? Promise.reject(new Error('the page has no painted surface to capture'))
      : Promise.resolve(new Uint8Array([1, 2])))
    const captured = await capturePainted(control(shot), [page('hidden', 'https://old/'), page('shown', 'https://live/')], 'png', undefined)
    expect(captured.page.url).toBe('https://live/')
    expect(captured.pageIdx).toBe(1)
    expect(captured.image.length).toBe(2)
  })

  it('refuses with the reason the shell gave when none can be painted', async () => {
    const denied = control(() => Promise.reject(new Error('the application window is minimized')))
    await expect(capturePainted(denied, [page('a', 'https://a/')], 'png', undefined))
      .rejects.toThrow('the application window is minimized')
  })

  it('treats an empty image as a page that could not be painted', async () => {
    const captured = await capturePainted(
      control(() => Promise.resolve(new Uint8Array(0))),
      [page('a', 'https://a/')],
      'png',
      undefined,
    ).catch((error: unknown) => error)
    expect(captured).toBeInstanceOf(Error)
    expect((captured as Error).message).toBe('the page produced an empty image')
  })
})
