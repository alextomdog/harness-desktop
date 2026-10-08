/**
 * How WebSocket capture is read back.
 *
 * The frames are already in hand: enabling the Network domain is what makes the
 * protocol report them, and they land in the same log the console and traffic listings
 * read. What these helpers add is the shape an agent can talk about — connections
 * numbered in the order the page opened them, so a `wsid` from one call still names the
 * same socket in the next, and frames in the order they crossed the wire.
 *
 * The numbering exists because the protocol's own `requestId` cannot be listed and then
 * asked about: it is an internal string, and a listing has to show something a caller
 * can repeat back.
 */
import { describe, expect, it } from 'vitest'
import { framesOf, socketsOf } from '../src/browser-tools.ts'
import type { DesktopBrowserEvent } from '../src/browser-cdp.ts'

const event = (seq: number, method: string, params: unknown): DesktopBrowserEvent => ({ seq, method, params })
const created = (seq: number, requestId: string, url: string): DesktopBrowserEvent =>
  event(seq, 'Network.webSocketCreated', { requestId, url })
const sent = (seq: number, requestId: string, payloadData: string): DesktopBrowserEvent =>
  event(seq, 'Network.webSocketFrameSent', { requestId, response: { opcode: 1, payloadData } })
const received = (seq: number, requestId: string, payloadData: string): DesktopBrowserEvent =>
  event(seq, 'Network.webSocketFrameReceived', { requestId, response: { opcode: 1, payloadData } })

describe('socketsOf', () => {
  it('numbers the connections a page opened in the order it opened them', () => {
    const sockets = socketsOf([
      created(1, 'r1', 'wss://example.test/one'),
      sent(2, 'r1', 'a'),
      created(3, 'r2', 'wss://example.test/two'),
    ])
    expect(sockets).toEqual([
      { wsid: 1, requestId: 'r1', url: 'wss://example.test/one', closed: false },
      { wsid: 2, requestId: 'r2', url: 'wss://example.test/two', closed: false },
    ])
  })

  it('marks a closed socket without renumbering the ones beside it', () => {
    const sockets = socketsOf([
      created(1, 'r1', 'wss://example.test/one'),
      created(2, 'r2', 'wss://example.test/two'),
      event(3, 'Network.webSocketClosed', { requestId: 'r1' }),
    ])
    expect(sockets.map(socket => [socket.wsid, socket.closed])).toEqual([[1, true], [2, false]])
    // The second socket keeps the number it was listed under before the first closed.
    expect(sockets[1]!.wsid).toBe(2)
  })

  it('ignores traffic that names no socket', () => {
    expect(socketsOf([event(1, 'Network.requestWillBeSent', { requestId: 'r9' })])).toEqual([])
  })
})

describe('framesOf', () => {
  it('orders frames by exchange and labels their direction', () => {
    const sockets = socketsOf([created(1, 'r1', 'wss://example.test/one')])
    const frames = framesOf([
      created(1, 'r1', 'wss://example.test/one'),
      sent(2, 'r1', 'hello'),
      received(3, 'r1', 'world'),
    ], sockets)
    expect(frames).toEqual([
      { index: 1, wsid: 1, direction: 'sent', opcode: 1, payload: 'hello' },
      { index: 2, wsid: 1, direction: 'received', opcode: 1, payload: 'world' },
    ])
  })

  it('keeps each frame with the socket that carried it', () => {
    const sockets = socketsOf([
      created(1, 'r1', 'wss://example.test/one'),
      created(2, 'r2', 'wss://example.test/two'),
    ])
    const frames = framesOf([
      created(1, 'r1', 'wss://example.test/one'),
      created(2, 'r2', 'wss://example.test/two'),
      sent(3, 'r2', 'two'),
      sent(4, 'r1', 'one'),
    ], sockets)
    expect(frames.map(frame => [frame.index, frame.wsid, frame.payload])).toEqual([[1, 2, 'two'], [2, 1, 'one']])
  })

  it('ignores frames no listed socket carried', () => {
    expect(framesOf([sent(1, 'unknown', 'x')], socketsOf([]))).toEqual([])
  })
})
