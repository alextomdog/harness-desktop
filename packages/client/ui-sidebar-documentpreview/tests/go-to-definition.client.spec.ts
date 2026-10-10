/**
 * Finding a definition in one file's text.
 *
 * The contract worth pinning is what it does when it cannot answer: a jump that lands nowhere tells
 * the reader the truth, while one that lands somewhere approximate does not.
 */
import { describe, expect, it } from 'vitest'
import { findDefinition, wordAt } from '../src/client/editable/definition.ts'

describe('the word at an offset', () => {
  it('reads the identifier a caret sits inside', () => {
    expect(wordAt('const value = 1', 8)).toBe('value')
  })

  it('answers nothing for whitespace and punctuation', () => {
    expect(wordAt('a  b', 2)).toBeUndefined()
    expect(wordAt('a = b', 2)).toBeUndefined()
  })
})

describe('a definition in one file', () => {
  it('finds a Python function and points at its name', () => {
    const text = ['import sys', '', 'def draw_absolute_panel(ax):', '    pass', ''].join('\n')
    const hit = findDefinition(text, 'draw_absolute_panel')
    expect(hit?.name).toBe('draw_absolute_panel')
    // The offset is the name itself, not the line: that is where a reader's eye should land.
    expect(text.slice(hit?.offset ?? 0, (hit?.offset ?? 0) + 19)).toBe('draw_absolute_panel')
  })

  it('finds a Python class', () => {
    expect(findDefinition(['class Figure:', '    pass'].join('\n'), 'Figure')?.offset).toBe(6)
  })

  it('finds the shapes JavaScript and TypeScript introduce names with', () => {
    expect(findDefinition('const GRID = 1', 'GRID')?.offset).toBe(6)
    expect(findDefinition('export function draw() {}', 'draw')?.offset).toBe(16)
    expect(findDefinition('export interface Point { x: number }', 'Point')?.offset).toBe(17)
    expect(findDefinition('async function load(): Promise<void> {}', 'load')?.offset).toBe(15)
  })

  it('answers nothing when this file does not define the name', () => {
    // The honest answer, and the one that keeps a jump from lying.
    expect(findDefinition('const a = 1', 'b')).toBeUndefined()
    expect(findDefinition('', 'anything')).toBeUndefined()
    expect(findDefinition('const a = 1', '')).toBeUndefined()
  })

  it('takes the first definition when a name appears twice', () => {
    expect(findDefinition(['def run():', '    pass', 'def run():', '    pass'].join('\n'), 'run')?.offset).toBe(4)
  })
})
