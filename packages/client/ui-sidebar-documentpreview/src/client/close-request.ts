/**
 * The dock's close, reachable from a tab body.
 *
 * The body knows when the reader wants a tab gone — they just answered the close question —
 * and the dock is the only thing that can take it away, but the body has no dock to ask: the
 * service lives in the plugin's scope, one level up and outside the body's props. This is the
 * one reference that crosses that line, set by the plugin while it is mounted and cleared
 * with it, so a body can never ask a dock that is no longer there.
 */
let close: ((tabId: string) => void) | undefined

/**
 * Install the dock's close.
 * @param handler - the dock's own close, or undefined while none is mounted.
 * @returns a remover that unsets it, for the plugin's effect.
 */
export function setTabClose(handler: ((tabId: string) => void) | undefined): () => void {
  close = handler
  return () => { if (close === handler) close = undefined }
}

/**
 * Ask the dock to close one tab.
 * @param tabId - the tab to close.
 * @returns whether a dock was there to take the request.
 */
export function requestTabClose(tabId: string): boolean {
  if (close === undefined) return false
  close(tabId)
  return true
}
