/**
 * Whether a page is stopped, and where.
 *
 * A pause and its resume are both events, so the answer is whichever came last — and
 * replaying the log is the only way to get it: a stopped page cannot answer
 * `Runtime.evaluate`, so the pause family is built on capture rather than on a query.
 * The sequence matters as much as the state: after a step, the caller has to be able to
 * tell the new stop from the one it just left.
 */
import { describe, expect, it } from 'vitest'
import { pausedStateOf } from '../src/browser-tools.ts'
import type { DesktopBrowserEvent } from '../src/browser-cdp.ts'

const event = (seq: number, method: string, params: unknown): DesktopBrowserEvent => ({ seq, method, params })
const pause = (seq: number, reason: string, functionName: string): DesktopBrowserEvent =>
  event(seq, 'Debugger.paused', {
    reason,
    callFrames: [{ functionName, url: 'http://127.0.0.1:8123/', location: { lineNumber: 4, columnNumber: 9 }, callFrameId: `f${String(seq)}` }],
    hitBreakpoints: [],
  })

describe('pausedStateOf', () => {
  it('reports a running page when nothing paused it', () => {
    expect(pausedStateOf([event(1, 'Runtime.consoleAPICalled', {})])).toBeUndefined()
  })

  it('reports the stop, with its frames and the sequence it arrived at', () => {
    const state = pausedStateOf([pause(7, 'other', 'tick')])
    expect(state?.sequence).toBe(7)
    expect(state?.reason).toBe('other')
    expect(state?.callFrames[0]?.functionName).toBe('tick')
    expect(state?.callFrames[0]?.callFrameId).toBe('f7')
  })

  it('clears the stop when the page resumes', () => {
    expect(pausedStateOf([pause(7, 'other', 'tick'), event(8, 'Debugger.resumed', {})])).toBeUndefined()
  })

  it('reports the latest stop, so a step can be told from the stop before it', () => {
    const state = pausedStateOf([
      pause(7, 'other', 'first'),
      event(8, 'Debugger.resumed', {}),
      pause(9, 'step', 'second'),
    ])
    expect(state?.sequence).toBe(9)
    expect(state?.callFrames[0]?.functionName).toBe('second')
  })
})
