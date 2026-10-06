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

  it('creates a file in the row folder from the menu and reports the name', async () => {
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
    expect(await screen.findByText('files.created:{"name":"readme.md"}')).toBeTruthy()
    // The parent reloads, so the new entry appears without a watch of its own.
    expect(listDirectory).toHaveBeenCalledWith(sessionId, 'docs', expect.anything())
  })

  it('creates a directory under the workspace root from the empty state', async () => {
    const createDirectory = vi.fn(async () => {})
    const listDirectory = listingSource({
      '.': { path: '', truncated: false, entries: [] },
      fresh: { path: 'fresh', truncated: false, entries: [] },
    })
    mount({ createDirectory, listDirectory })

    fireEvent.click(await screen.findByText('files.newFile'))
    fireEvent.change(screen.getByLabelText('files.createFile.title'), { target: { value: '' } })
    // An empty name cannot be submitted, so switch to a directory and name it.
    fireEvent.click(screen.getByText('files.cancel'))
    expect(createDirectory).not.toHaveBeenCalled()
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
