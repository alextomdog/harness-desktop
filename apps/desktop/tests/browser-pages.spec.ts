/**
 * Which live guests may be offered as pages.
 *
 * The failure this guards against was reported by a user, not found by a test: they
 * closed a browser tab, asked the agent which pages it could see, and it named the
 * page they had just closed. The guest for a retained tab outlives its page, and
 * Chromium keeps the last title across a navigation to a blank document — so the
 * entry looked exactly like a page that was still open.
 */
import { describe, expect, it } from 'vitest'
import { offersPage } from '../src/browser-pages.ts'

describe('offersPage', () => {
  it('accepts a guest that is on a real document', () => {
    expect(offersPage('https://example.com/')).toBe(true)
    expect(offersPage('http://127.0.0.1:19387/?token=abc')).toBe(true)
    expect(offersPage('file:///D:/tmp/note.md')).toBe(true)
    // about:blank is only ever the placeholder itself; anything else on about: is a
    // real document a page can occupy.
    expect(offersPage('about:blank?x=1')).toBe(true)
  })

  it('refuses the bootstrap document and a closed page', () => {
    expect(offersPage('')).toBe(false)
    expect(offersPage('about:blank')).toBe(false)
    // The shell navigates a fresh guest to `about:blank#<lease>` to give it its
    // partition: a reservation, not a page.
    expect(offersPage('about:blank#0f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8')).toBe(false)
  })
})
