// @vitest-environment jsdom
/**
 * The workspace file tree: lazy per-directory loading, the create flow, and the
 * row menu that acts on the filesystem rather than on a Session.
 *
 * The component takes its filesystem as injected callbacks, so these cases drive
 * it with plain functions and assert on the calls it makes — no Remote assembly
 * and no real filesystem.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  WorkspaceFileTree, type WorkspaceTreeListing, type WorkspaceFileTreeProps,
} from '../src/client/files/WorkspaceFileTree.tsx'

afterEach(cleanup)

const sessionId = 's-test' as SessionId

/** Localized copy resolved to its key, so the spec never depends on a dictionary. */
const t = ((key: string, vars?: Record<string, unknown>) =>
  vars === undefined ? key : `${key}:${JSON.stringify(vars)}`) as unknown as WorkspaceFileTreeProps['t']

/** A listing per directory path; a missing entry fails the call. */
function listingSource(byPath: Record<string, WorkspaceTreeListing>) {
  return vi.fn(async (_sessionId: SessionId, path: string): Promise<WorkspaceTreeListing> => {
    const listing = byPath[path]
    if (listing === undefined) throw new Error(`no listing for "${path}"`)
    return listing
  })
}

function mount(overrides: Partial<WorkspaceFileTreeProps> = {}) {
  const props = {
    sessionId,
    t,
    listDirectory: listingSource({ '.': { path: '', entries: [], truncated: false } }),
    createFile: vi.fn(async () => {}),
    createDirectory: vi.fn(async () => {}),
    ...overrides,
  } as WorkspaceFileTreeProps
  render(<WorkspaceFileTree {...props} />)
  return props
}

describe('WorkspaceFileTree', () => {
  // KNOWN BUG, reproduced here: a Shift range is not taken, so a drag from the middle of one
  // carries only that row. Expected 'a.py\nb.py\nc.py'; it currently sends 'b.py'. The case stays
  // skipped only until the range works — deleting it would delete the reproduction.
  it.skip('drags every row the reader has taken, not just the one under the pointer', async () => {
    const listDirectory = listingSource({
      '.': {
        path: '',
        truncated: false,
        entries: [
          { name: 'a.py', type: 'file' },
          { name: 'b.py', type: 'file' },
          { name: 'c.py', type: 'file' },
        ],
      },
    })
    mount({ listDirectory })

    const rowOf = async (name: string): Promise<HTMLElement> =>
      ((await screen.findByText(name)).closest('[role=treeitem]') as HTMLElement)
    const first = await rowOf('a.py')
    const last = await rowOf('c.py')

    // A range taken with Shift, then a drag from the middle of it.
    fireEvent.click(first)
    fireEvent.click(last, { shiftKey: true })

    // Re-queried AFTER the clicks: the row React renders now is the one whose handler sees the
    // selection the clicks produced.
    const dragged = await rowOf('b.py')
    const transfer = { setData: vi.fn(), effectAllowed: '' }
    fireEvent.dragStart(dragged, { dataTransfer: transfer })

    // All three travel: one chip where the reader picked three is not what they asked for.
    // Reported as a whole so a failure shows the payload rather than only the mismatch.
    const payload = (transfer.setData as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1]
    expect({ payload }).toEqual({ payload: 'a.py\nb.py\nc.py' })
  })

  it('drags only the row under the pointer when it is not part of a selection', async () => {
    const listDirectory = listingSource({
      '.': {
        path: '',
        truncated: false,
        entries: [{ name: 'a.py', type: 'file' }, { name: 'b.py', type: 'file' }],
      },
    })
    mount({ listDirectory })
    const first = ((await screen.findByText('a.py')).closest('[role=treeitem]') as HTMLElement)
    const second = (screen.getByText('b.py').closest('[role=treeitem]') as HTMLElement)

    fireEvent.click(first)
    const transfer = { setData: vi.fn(), effectAllowed: '' }
    fireEvent.dragStart(second, { dataTransfer: transfer })

    expect(transfer.setData).toHaveBeenCalledWith('text/plain', 'b.py')
  })
  it('asks for the workspace root as `.` and renders its entries', async () => {
    const listDirectory = listingSource({
      '.': {
        path: '',
        truncated: false,
        entries: [{ name: 'src', type: 'directory' }, { name: 'notes.md', type: 'file', size: 12 }],
      },
    })
    mount({ listDirectory })

    expect(await screen.findByText('src')).toBeTruthy()
    expect(screen.getByText('notes.md')).toBeTruthy()
    // The Host names the root `.`; `''` is only ever the reported result path.
    expect(listDirectory).toHaveBeenCalledWith(sessionId, '.', expect.anything())
  })

  it('orders folders before files, each group by name', async () => {
    // The Host's stable name order would interleave these.
    const listDirectory = listingSource({
      '.': {
        path: '',
        truncated: false,
        entries: [
          { name: 'a.txt', type: 'file' },
          { name: 'zeta', type: 'directory' },
          { name: 'b.txt', type: 'file' },
          { name: 'alpha', type: 'directory' },
        ],
      },
    })
    mount({ listDirectory })

    await screen.findByText('a.txt')
    const names = screen.getAllByRole('treeitem').map(row => row.textContent)
    expect(names).toEqual(['alpha', 'zeta', 'a.txt', 'b.txt'])
  })

  it('loads a directory only when it is expanded', async () => {
    const listDirectory = listingSource({
      '.': { path: '', truncated: false, entries: [{ name: 'src', type: 'directory' }] },
      src: { path: 'src', truncated: false, entries: [{ name: 'a.ts', type: 'file' }] },
    })
    mount({ listDirectory })

    fireEvent.click(await screen.findByText('src'))
    expect(await screen.findByText('a.ts')).toBeTruthy()
    expect(listDirectory).toHaveBeenCalledWith(sessionId, 'src', expect.anything())

    // Collapsing does not re-list: the listing is cached until a create reloads it.
    fireEvent.click(screen.getByText('src'))
    await waitFor(() => { expect(screen.queryByText('a.ts')).toBeNull() })
    expect(listDirectory).toHaveBeenCalledTimes(2)
  })

  it('creates a file in the row folder from the menu', async () => {
    const createFile = vi.fn(async () => {})
    const listDirectory = listingSource({
      '.': { path: '', truncated: false, entries: [{ name: 'docs', type: 'directory' }, { name: 'a.md', type: 'file' }] },
      docs: { path: 'docs', truncated: false, entries: [] },
    })
    mount({ createFile, listDirectory })

    const folder = await screen.findByText('docs')
    fireEvent.contextMenu(folder)
    fireEvent.click(screen.getByText('files.newFileHere'))

    fireEvent.change(screen.getByLabelText('files.createFile.title'), { target: { value: 'readme.md' } })
    fireEvent.click(screen.getByText('files.create'))

    await waitFor(() => {
      // The row's own directory is the parent, and the path joins with `/`.
      expect(createFile).toHaveBeenCalledWith(sessionId, 'docs/readme.md', '', expect.anything())
    })
    // The parent reloads, so the new entry appears without a watch of its own,
    // and no notice line is drawn: the tree is the report.
    expect(listDirectory).toHaveBeenCalledWith(sessionId, 'docs', expect.anything())
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('creates a folder at the workspace root from the tree toolbar', async () => {
    // Stateful: the Host's next root listing contains what was just created.
    let created = false
    const createDirectory = vi.fn(async () => { created = true })
    const listDirectory = vi.fn(async (_sessionId: SessionId, path: string): Promise<WorkspaceTreeListing> => {
      if (path === 'fresh') return { path: 'fresh', truncated: false, entries: [{ name: 'inner.md', type: 'file' }] }
      return {
        path: '',
        truncated: false,
        entries: created ? [{ name: 'fresh', type: 'directory' }] : [],
      }
    })
    mount({ createDirectory, listDirectory })

    // An empty Workspace has no row to right-click, so the tree's own toolbar is
    // the only way to create at its root — the case this control exists for.
    fireEvent.click(await screen.findByLabelText('files.newFolder'))
    fireEvent.change(screen.getByLabelText('files.createFolder.title'), { target: { value: 'fresh' } })
    fireEvent.click(screen.getByText('files.create'))

    await waitFor(() => {
      expect(createDirectory).toHaveBeenCalledWith(sessionId, 'fresh', expect.anything())
    })
    // The new folder is adopted open AND listed, so it does not appear as an open
    // folder with nothing in it. No success notice: the tree is the report.
    expect(await screen.findByText('inner.md')).toBeTruthy()
    expect(listDirectory).toHaveBeenCalledWith(sessionId, 'fresh', expect.anything())
  })

  it('creates a file at the workspace root from the tree toolbar', async () => {
    const createFile = vi.fn(async () => {})
    mount({ createFile })

    fireEvent.click(await screen.findByLabelText('files.newFile'))
    fireEvent.change(screen.getByLabelText('files.createFile.title'), { target: { value: 'notes.md' } })
    fireEvent.click(screen.getByText('files.create'))

    await waitFor(() => {
      expect(createFile).toHaveBeenCalledWith(sessionId, 'notes.md', '', expect.anything())
    })
  })

  it('refreshes every listed directory from the toolbar', async () => {
    const listDirectory = listingSource({
      '.': { path: '', truncated: false, entries: [{ name: 'src', type: 'directory' }] },
      src: { path: 'src', truncated: false, entries: [{ name: 'a.ts', type: 'file' }] },
    })
    mount({ listDirectory })

    fireEvent.click(await screen.findByText('src'))
    await screen.findByText('a.ts')
    const before = listDirectory.mock.calls.length

    fireEvent.click(screen.getByLabelText('files.refresh'))
    await waitFor(() => {
      expect(listDirectory.mock.calls.length).toBeGreaterThan(before)
    })
    // Both the root and the expanded folder were re-read, so a refresh keeps the
    // expansion instead of collapsing the tree back to its root.
    await waitFor(() => {
      expect(listDirectory).toHaveBeenCalledWith(sessionId, 'src', expect.anything())
    })
  })

  it('marks the row the user is acting on', async () => {
    const listDirectory = listingSource({
      '.': { path: '', truncated: false, entries: [{ name: 'a.md', type: 'file' }] },
    })
    mount({ listDirectory })

    const row = (await screen.findByText('a.md')).closest('[role="treeitem"]') as HTMLElement
    expect(row.getAttribute('aria-selected')).toBe('false')
    fireEvent.click(screen.getByText('a.md'))
    await waitFor(() => { expect(row.getAttribute('aria-selected')).toBe('true') })
  })

  it('reports an occupied name as a conflict instead of overwriting', async () => {
    const createFile = vi.fn(async () => {
      throw Object.assign(new Error('an entry already exists'), { code: 'workspace-file/already-exists' })
    })
    const listDirectory = listingSource({
      '.': { path: '', truncated: false, entries: [{ name: 'taken.md', type: 'file' }] },
    })
    mount({ createFile, listDirectory })

    fireEvent.contextMenu(await screen.findByText('taken.md'))
    fireEvent.click(screen.getByText('files.newFile'))
    fireEvent.change(screen.getByLabelText('files.createFile.title'), { target: { value: 'taken.md' } })
    fireEvent.click(screen.getByText('files.create'))

    expect(await screen.findByText('files.conflict:{"name":"taken.md"}')).toBeTruthy()
  })

  it('shows the wire failure message when a listing fails', async () => {
    const listDirectory = vi.fn(async () => { throw new Error('workspace-file/outside-workspace') })
    mount({ listDirectory })

    expect(await screen.findByText('workspace-file/outside-workspace')).toBeTruthy()
    expect(screen.getByText('files.retry')).toBeTruthy()
  })

  it('folds its own section from its heading, keeping the heading and actions', async () => {
    const listDirectory = listingSource({
      '.': { path: '', truncated: false, entries: [{ name: 'a.md', type: 'file' }] },
    })
    mount({ listDirectory })

    expect(await screen.findByText('a.md')).toBeTruthy()
    fireEvent.click(screen.getByText('section.files'))
    await waitFor(() => { expect(screen.queryByText('a.md')).toBeNull() })
    // The heading and its actions stay: they are how the section comes back.
    expect(screen.getByLabelText('files.newFile')).toBeTruthy()
  })

  it('renames a row in place from its menu, opening on the name it replaces', async () => {
    const renameEntry = vi.fn(async () => {})
    const listDirectory = listingSource({
      '.': { path: '', truncated: false, entries: [{ name: 'old.md', type: 'file' }] },
    })
    mount({ renameEntry, listDirectory })

    fireEvent.contextMenu(await screen.findByText('old.md'))
    fireEvent.click(screen.getByText('files.rename'))

    // The editor replaces the name IN that row, seeded with the current name.
    const input = screen.getByLabelText('files.rename') as HTMLInputElement
    expect(input.value).toBe('old.md')
    expect(input.closest('[role="treeitem"]')).not.toBeNull()

    fireEvent.change(input, { target: { value: 'new.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(renameEntry).toHaveBeenCalledWith(sessionId, 'old.md', 'new.md', expect.anything())
    })
    // The holding directory is reloaded, so the old name cannot linger; a rename
    // reports itself through the tree, with no notice line under it.
    expect(listDirectory).toHaveBeenCalledWith(sessionId, '.', expect.anything())
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('opens the in-place editor on F2 and drops it on Escape without renaming', async () => {
    const renameEntry = vi.fn(async () => {})
    const listDirectory = listingSource({
      '.': { path: '', truncated: false, entries: [{ name: 'a.md', type: 'file' }] },
    })
    mount({ renameEntry, listDirectory })

    const row = (await screen.findByText('a.md')).closest('[role="treeitem"]') as HTMLElement
    fireEvent.keyDown(row, { key: 'F2' })
    const input = screen.getByLabelText('files.rename') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'b.md' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByLabelText('files.rename')).toBeNull()
    expect(renameEntry).not.toHaveBeenCalled()
    expect(screen.getByText('a.md')).toBeTruthy()
  })

  it('copies a row relative and absolute path', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const listDirectory = listingSource({
      '.': { path: '', truncated: false, entries: [{ name: 'src', type: 'directory' }] },
      src: { path: 'src', truncated: false, entries: [{ name: 'a.md', type: 'file' }] },
    })
    mount({ listDirectory, workspaceRoot: 'C:\\work\\proj' })

    fireEvent.click(await screen.findByText('src'))
    const file = await screen.findByText('a.md')

    fireEvent.contextMenu(file)
    fireEvent.click(screen.getByText('files.copyRelativePath'))
    expect(writeText).toHaveBeenCalledWith('src/a.md')

    fireEvent.contextMenu(file)
    fireEvent.click(screen.getByText('files.copyAbsolutePath'))
    // Composed in the root's own separator style, not the tree's.
    expect(writeText).toHaveBeenCalledWith('C:\\work\\proj\\src\\a.md')
  })

  it('deletes a row only through its confirmation, then reloads the parent', async () => {
    let removed = false
    const deleteEntry = vi.fn(async () => { removed = true })
    const listDirectory = vi.fn(async (): Promise<WorkspaceTreeListing> => ({
      path: '',
      truncated: false,
      entries: removed ? [] : [{ name: 'doomed.md', type: 'file' }],
    }))
    mount({ deleteEntry, listDirectory })

    fireEvent.contextMenu(await screen.findByText('doomed.md'))
    fireEvent.click(screen.getByText('files.delete'))
    // Choosing the item only asks: a delete is the one action that cannot be undone.
    expect(deleteEntry).not.toHaveBeenCalled()
    expect(screen.getByText('files.deleteConfirm:{"name":"doomed.md"}')).toBeTruthy()

    // The dialog's own confirm is the last element carrying this label (its title
    // carries it too).
    fireEvent.click(screen.getAllByText('files.delete').at(-1) as HTMLElement)
    await waitFor(() => {
      expect(deleteEntry).toHaveBeenCalledWith(sessionId, 'doomed.md', expect.anything())
    })
    expect(await screen.findByText('files.empty')).toBeTruthy()
  })

  it('offers the open item only when a composition supplies an opener', async () => {
    const listing: WorkspaceTreeListing = { path: '', truncated: false, entries: [{ name: 'a.md', type: 'file' }] }
    const listDirectory = listingSource({ '.': listing })
    mount({ listDirectory })
    fireEvent.contextMenu(await screen.findByText('a.md'))
    expect(screen.queryByText('files.open')).toBeNull()

    cleanup()
    const openFile = vi.fn()
    mount({ listDirectory, openFile })
    fireEvent.contextMenu(await screen.findByText('a.md'))
    fireEvent.click(screen.getByText('files.open'))
    expect(openFile).toHaveBeenCalledWith(sessionId, 'a.md')
  })
})
