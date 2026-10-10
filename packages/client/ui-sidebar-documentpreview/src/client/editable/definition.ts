/**
 * Finding where a name is defined, inside one file's text.
 *
 * Deliberately one file and one pass: the editor is a textarea, not a language server, and a jump
 * that guesses is worse than a jump that does not happen. Nothing here decodes a module graph, a
 * re-export or a receiver type — it answers only "is this name defined in the text in front of me",
 * and answers undefined when it cannot.
 */

/** One definition found in a file's text. */
export interface DefinitionHit {
  /** Offset of the defined name itself, which is where a reader's eye should land. */
  readonly offset: number
  /** The name as it was defined, which is the word the caller asked about. */
  readonly name: string
}

/** The word a caret sits in, or undefined when it sits in nothing word-shaped. */
const WORD = /[A-Za-z_$][\w$]*/

/**
 * The word at one offset.
 * @param text - the document's text.
 * @param offset - a caret offset into it.
 * @returns the identifier spanning that offset, or undefined in whitespace or punctuation.
 */
export function wordAt(text: string, offset: number): string | undefined {
  if (offset < 0 || offset > text.length) return undefined
  // A caret just after a word belongs to that word, which is how every editor treats a click at its
  // edge; one just before it belongs to the word it precedes.
  const start = offset === text.length ? offset - 1 : offset
  const left = text.slice(0, start + 1).match(new RegExp(`${WORD.source}$`))?.[0]
  const right = text.slice(start).match(new RegExp(`^${WORD.source}`))?.[0]
  // Prefer the word the caret is inside over the one it touches from either side.
  if (left !== undefined && right !== undefined && text[start] !== undefined && WORD.test(text[start] ?? '')) {
    return text.slice(start - left.length + 1, start + right.length)
  }
  return left ?? right
}

/** Ways a name is introduced, per family of language the editor shows. */
const DEFINITIONS: readonly RegExp[] = [
  // Python.
  /^\s*(?:async\s+)?def\s+(?<name>WORD)\s*\(/,
  /^\s*class\s+(?<name>WORD)\b/,
  // JavaScript and TypeScript.
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(?<name>WORD)\b/,
  /^\s*(?:export\s+)?(?:default\s+)?class\s+(?<name>WORD)\b/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+(?<name>WORD)\s*[:=]/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+(?<name>WORD)\b/,
  // A method or a field introduced with a name and a call or an assignment, anywhere it is indented.
  /^\s*(?:public|private|protected|static|readonly|def\s+)*\s*(?<name>WORD)\s*(?:\(|=[^=])/,
].map(pattern => new RegExp(pattern.source.replaceAll('WORD', WORD.source)))

/**
 * Where a name is defined in one file's text.
 *
 * First match wins, top to bottom, because that is the order a reader scans and the order a file
 * usually declares things in. Nothing is returned when nothing matches: a caller that jumps nowhere
 * tells its reader the truth, while a caller that jumps somewhere approximate does not.
 * @param text - the document's text.
 * @param name - the identifier to look for.
 * @returns the definition found, or undefined when this file does not define it.
 */
export function findDefinition(text: string, name: string): DefinitionHit | undefined {
  if (name === '') return undefined
  for (const pattern of DEFINITIONS) {
    const lines = text.split('\n')
    let lineStart = 0
    for (const line of lines) {
      const match = pattern.exec(line)
      const found = match?.groups?.name
      if (found === name && match !== null) {
        return { offset: lineStart + (match.index ?? 0) + match[0].indexOf(name), name }
      }
      lineStart += line.length + 1
    }
  }
  return undefined
}
