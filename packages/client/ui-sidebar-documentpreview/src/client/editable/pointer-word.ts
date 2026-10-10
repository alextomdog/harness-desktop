/**
 * Which word a pointer is over, inside the editor's painted text.
 *
 * The editor is a layered thing: a transparent textarea holds the real caret and sits above a
 * painted copy of the same text. Hit testing therefore answers about the textarea — which has no DOM
 * text inside it — unless the textarea steps aside for the instant of the test. That is what this
 * does, and it puts the textarea back afterwards no matter how the test ends.
 */

/** The least a pointer hit test needs of the element it is aiming at. */
export interface HitTestableSurface {
  /** The element that would otherwise win the hit test. */
  readonly cover: HTMLElement | null
  /** The painted element holding the same text, which the test should reach. */
  readonly painted: HTMLElement | null
}

/** The document's own caret-from-point, when this browser has one. */
interface CaretFromPoint {
  caretRangeFromPoint?(x: number, y: number): Range | null
  caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null
}

/**
 * The character offset into the painted text that a viewport point falls on.
 *
 * The cover is hidden for exactly the length of the test and restored in a finally, because a thrown
 * error must not leave the editor unable to receive a click.
 * @param surface - the covering element and the painted one beneath it.
 * @param x - viewport x.
 * @param y - viewport y.
 * @returns the offset into the painted text, or undefined when this browser or point cannot answer.
 */
export function offsetAtPoint(surface: HitTestableSurface, x: number, y: number): number | undefined {
  const { cover, painted } = surface
  if (painted === null) return undefined
  const previous = cover?.style.pointerEvents
  if (cover !== null) cover.style.pointerEvents = 'none'
  try {
    const api = document as Document & CaretFromPoint
    const range = api.caretRangeFromPoint?.(x, y)
    if (range !== null && range !== undefined) {
      if (!painted.contains(range.startContainer)) return undefined
      return offsetWithin(painted, range.startContainer, range.startOffset)
    }
    const position = api.caretPositionFromPoint?.(x, y)
    if (position === null || position === undefined) return undefined
    if (!painted.contains(position.offsetNode)) return undefined
    return offsetWithin(painted, position.offsetNode, position.offset)
  } finally {
    if (cover !== null) cover.style.pointerEvents = previous ?? ''
  }
}

/**
 * How many characters of the painted text precede one point inside it.
 *
 * Counted per painted LINE rather than per text node, because the layer is one element per line and
 * the newline between two lines is in neither of them. Summing text nodes alone drifts one character
 * per preceding line — invisible near the top of a file and wrong everywhere else, which is exactly
 * the kind of error a reader meets only in a long document.
 * @param root - the painted element.
 * @param node - the text node the browser reported.
 * @param offset - the offset within that node.
 * @returns the offset into the whole painted text.
 */
function offsetWithin(root: HTMLElement, node: Node, offset: number): number | undefined {
  let total = 0
  for (const line of Array.from(root.children)) {
    if (!line.contains(node)) {
      total += (line.textContent?.length ?? 0) + 1
      continue
    }
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
      if (current === node) return total + offset
      total += current.textContent?.length ?? 0
    }
    return undefined
  }
  // The point landed on the painted element itself rather than inside a line: nothing precedes it.
  return node === root ? 0 : undefined
}
