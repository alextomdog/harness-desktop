// @vitest-environment jsdom
/**
 * What a click resolves to, and what it refuses.
 *
 * The expression answers instead of throwing so that the three ways it can fail stay
 * distinguishable: a selector matching nothing, one matching several without an index,
 * and an element that exists but is not painted need different fixes, and a caller that
 * only sees "click failed" cannot tell which it has. The coordinates it returns are what
 * the protocol's mouse events take, so they are checked here too.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { resolveClickExpression } from '../src/browser-tools.ts'
import type { ClickResolution } from '../src/browser-tools.ts'

/** Evaluate the expression the way the page would, and read its answer. */
function resolve(selector: string, index?: number): ClickResolution {
  return (0, eval)(resolveClickExpression(selector, index)) as ClickResolution
}

beforeEach(() => { document.body.innerHTML = '' })

describe('resolveClickExpression', () => {
  it('returns the centre of the one element that matches', () => {
    document.body.innerHTML = '<button id="go" style="position:fixed;left:10px;top:20px;width:100px;height:40px">Go</button>'
    // jsdom lays nothing out, so the rect is empty unless the element is given one.
    const button = document.querySelector('button')!
    button.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 40 }) as DOMRect
    const answer = resolve('#go')
    expect(answer).toMatchObject({ ok: true, x: 60, y: 40 })
    expect(answer.description).toBe('button#go Go')
  })

  it('refuses a selector that matches nothing', () => {
    expect(resolve('#missing')).toMatchObject({ ok: false, reason: 'nothing matches that selector' })
  })

  it('refuses several matches until an index names one', () => {
    document.body.innerHTML = '<p class="item">a</p><p class="item">b</p>'
    expect(resolve('.item')).toMatchObject({
      ok: false,
      reason: 'the selector matches 2 elements: pass index',
    })
    const second = document.querySelectorAll('.item')[1]!
    second.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10 }) as DOMRect
    expect(resolve('.item', 1)).toMatchObject({ ok: true, x: 5, y: 5 })
  })

  it('refuses an index nothing matches, and says how many there are', () => {
    document.body.innerHTML = '<p class="item">a</p>'
    expect(resolve('.item', 4)).toMatchObject({ ok: false, reason: 'no element at that index: 1 match' })
  })

  it('refuses an element that is present but not painted', () => {
    document.body.innerHTML = '<div id="hidden" style="display:none">x</div>'
    expect(resolve('#hidden')).toMatchObject({ ok: false, reason: 'the element is present but not painted' })
  })
})
