/**
 * The workspace file tree filling the sidebar's `sidebar.workspaces.files`
 * hole: the left region's counterpart to the right sidebar's `files` tab type.
 *
 * Directories load lazily and one level at a time — expanding a folder lists
 * only that folder — so opening the section costs one bounded `list` rather
 * than a walk of the tree. Row state is keyed by workspace-relative path, which
 * is the vocabulary `list` speaks, so the tree never has to know the workspace
 * root the Host derives from the Session header.
 *
 * The component sees the filesystem only through its injected callbacks: it
 * holds no Remote namespace and no resource navigator of its own, which is what
 * lets its spec drive it with plain functions. Its context menu is its own, not
 * the Session rows': its entries act on the filesystem (create a file, create a
 * folder, copy a path), while `sidebar.workspaces.session.menu.item` entries act
 * on a Session.
 */
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconCodeOutlineRegular,
  IconFolderCloseRegular, IconFolderOpenRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import css from './WorkspaceFileTree.module.css'

/** One directory child as the tree renders it; a structural subset of the Host listing. */
export interface WorkspaceTreeEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly size?: number
}

/** One directory listing as the tree consumes it. */
export interface WorkspaceTreeListing {
  /** Workspace-relative path of the listed directory; `''` is the workspace root. */
  readonly path: string
  readonly entries: readonly WorkspaceTreeEntry[]
  readonly truncated: boolean
}

/**
 * The filesystem actions the tree performs. `ui-workspace` binds these to the
 * `workspaceFiles` Remote namespace, so a create is the same create-if-absent
 * call the Host already fences to the Session's workspace.
 */
export interface WorkspaceFileTreeInjected {
  /** List one directory's direct children. */
  listDirectory: (sessionId: SessionId, path: string, signal: AbortSignal) => Promise<WorkspaceTreeListing>
  /** Create one new file; rejects when the path is already occupied. */
  createFile: (sessionId: SessionId, path: string, content: string, signal: AbortSignal) => Promise<void>
  /** Create one new directory; rejects when the path is already occupied. */
  createDirectory: (sessionId: SessionId, path: string, signal: AbortSignal) => Promise<void>
  /**
   * Reveal one file in the resource surface that owns file tabs. Optional: a
   * composition without that surface still gets a usable tree — expansion,
   * copy-path and the two creates — instead of a row that looks broken.
   */
  openFile?: (sessionId: SessionId, path: string) => void
}

/** Props of the file-tree entry: the owner share, the locale seat, and its actions. */
export type WorkspaceFileTreeProps =
  & { readonly sessionId: SessionId }
  & PropsLocale<'workspace'>
  & WorkspaceFileTreeInjected

/** One directory's load state, keyed by its workspace-relative path. */
interface DirectoryState {
  readonly status: 'loading' | 'ready' | 'error'
  readonly entries: readonly WorkspaceTreeEntry[]
  readonly truncated: boolean
  /** The wire failure's own message; shown untranslated, by the locale policy. */
  readonly failure?: string
}

/** One rendered row, flattened from the expanded tree. */
interface Row {
  readonly path: string
  readonly name: string
  readonly type: WorkspaceTreeEntry['type']
  readonly depth: number
}

/** The pending create, raised from the row menu or the section's own control. */
interface CreateRequest {
  readonly kind: 'file' | 'directory'
  /** Workspace-relative directory the new entry lands in; `''` is the workspace root. */
  readonly parent: string
}

/** The open row menu, positioned at the pointer. */
interface MenuState {
  readonly row: Row
  readonly left: number
  readonly top: number
}

const LOADING: DirectoryState = { status: 'loading', entries: [], truncated: false }
const ERRORED: DirectoryState = { status: 'error', entries: [], truncated: false }

/** Join a workspace-relative directory and a child name into a workspace path. */
function childPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`
}

/**
 * Flatten the loaded, expanded tree into rows. A directory whose listing has
 * not arrived yet contributes its own row only, so a slow folder never blocks
 * the rest of the tree.
 */
function flatten(directories: ReadonlyMap<string, DirectoryState>, expanded: ReadonlySet<string>): readonly Row[] {
  const rows: Row[] = []
  const visit = (path: string, depth: number): void => {
    const state = directories.get(path)
    if (state === undefined) return
    for (const entry of state.entries) {
      const entryPath = childPath(path, entry.name)
      rows.push({ path: entryPath, name: entry.name, type: entry.type, depth })
      if (entry.type === 'directory' && expanded.has(entryPath)) visit(entryPath, depth + 1)
    }
  }
  visit('', 0)
  return rows
}

/** The directory a new entry goes into for a row: the row itself, or its parent for a file. */
function createParent(row: Row): string {
  if (row.type !== 'directory') {
    const cut = row.path.lastIndexOf('/')
    return cut === -1 ? '' : row.path.slice(0, cut)
  }
  return row.path
}

/**
 * The workspace file tree.
 * @param props - owner Session, locale, and the filesystem actions.
 */
export function WorkspaceFileTree({
  sessionId, t, listDirectory, createFile, createDirectory, openFile,
}: WorkspaceFileTreeProps) {
  const [directories, setDirectories] = useState<ReadonlyMap<string, DirectoryState>>(new Map())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [request, setRequest] = useState<CreateRequest | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // The Session the tree is bound to for its whole life: a re-mount is what
  // re-scopes it, so a late reply from the previous Session cannot land here.
  const lifetime = useRef<AbortController>(new AbortController())

  const load = useCallback(async (path: string, signal: AbortSignal): Promise<void> => {
    setDirectories(current => new Map(current).set(path, LOADING))
    try {
      // The Host names the workspace root `.` and refuses an empty path, while
      // the tree keeps `''` as its own root key so every row path stays a plain
      // workspace-relative path.
      const listing = await listDirectory(sessionId, path === '' ? '.' : path, signal)
      if (signal.aborted) return
      setDirectories(current => new Map(current).set(path, {
        status: 'ready', entries: listing.entries, truncated: listing.truncated,
      }))
    } catch (error: unknown) {
      if (signal.aborted) return
      // A failure's own message is the most useful thing a user can be shown
      // here, and the locale policy keeps wire strings untranslated.
      const failure = error instanceof Error ? error.message : String(error)
      setDirectories(current => new Map(current).set(path, { ...ERRORED, failure }))
    }
  }, [listDirectory, sessionId])

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => { controller.abort() }
  }, [])

  const rootState = directories.get('')
  useEffect(() => {
    // The root lists once per Session: `load` is stable for a fixed Session.
    void load('', lifetime.current.signal)
  }, [load])

  const rows = useMemo(() => flatten(directories, expanded), [directories, expanded])

  const toggle = useCallback((path: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else {
        next.add(path)
        if (!directories.has(path)) void load(path, lifetime.current.signal)
      }
      return next
    })
  }, [directories, load])

  // A menu or prompt closes on any outside click or Escape, so neither can be
  // left stranded over a tree the user has moved on from.
  useEffect(() => {
    if (menu === null && request === null) return
    const close = (): void => { setMenu(null); setRequest(null) }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu, request])

  const beginCreate = useCallback((next: CreateRequest): void => {
    setMenu(null)
    setDraft('')
    setNotice(null)
    setRequest(next)
  }, [])

  const submitCreate = useCallback(async (): Promise<void> => {
    if (request === null) return
    const name = draft.trim()
    if (name === '') return
    const path = childPath(request.parent, name)
    setBusy(true)
    try {
      if (request.kind === 'file') await createFile(sessionId, path, '', lifetime.current.signal)
      else await createDirectory(sessionId, path, lifetime.current.signal)
      setNotice(t('files.created', { name }))
      setRequest(null)
      // The parent's cached listing is now stale; one reload keeps the tree
      // truthful without a watch subscription this section does not own.
      await load(request.parent, lifetime.current.signal)
      if (request.kind === 'directory') setExpanded(current => new Set(current).add(path))
    } catch (error: unknown) {
      setNotice(createFailure(error, t, name))
    } finally {
      setBusy(false)
    }
  }, [createDirectory, createFile, draft, load, request, sessionId, t])

  if (rootState === undefined || rootState.status === 'loading') {
    return <div className={css.state} role="status">{t('files.loading')}</div>
  }
  if (rootState.status === 'error') {
    return (
      <div className={css.state}>
        <span>{rootState.failure ?? t('files.error')}</span>
        <button type="button" className={css.retry} onClick={() => { void load('', lifetime.current.signal) }}>
          {t('files.retry')}
        </button>
      </div>
    )
  }
  if (rootState.entries.length === 0 && request === null) {
    return (
      <div className={css.state}>
        <span>{t('files.empty')}</span>
        <button type="button" className={css.retry} onClick={() => { beginCreate({ kind: 'file', parent: '' }) }}>
          {t('files.newFile')}
        </button>
      </div>
    )
  }

  return (
    <div className={css.root} role="tree" aria-label={t('files.newFile')}>
      <div className={css.rows}>
        {rows.map((row) => {
          const open = expanded.has(row.path)
          const directory = row.type === 'directory'
          return (
            <div
              key={row.path}
              className={css.row}
              style={{ '--dsh-file-depth': row.depth } as CSSProperties}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={directory ? open : undefined}
              tabIndex={0}
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setRequest(null)
                setMenu({ row, left: event.clientX, top: event.clientY })
              }}
              onClick={() => {
                if (directory) toggle(row.path)
                else openFile?.(sessionId, row.path)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                if (directory) toggle(row.path)
                else openFile?.(sessionId, row.path)
              }}
            >
              {/* Tree-view chrome, in the Explorer's order: the disclosure
                  twisty, then the entry's own glyph, then its name. Both cells
                  keep their width for files, so names align down a folder. */}
              <span className={css.twisty} aria-hidden="true">
                {directory && (open
                  ? <IconChevronDownOutlineRegular size={14} />
                  : <IconChevronRightOutlineRegular size={14} />)}
              </span>
              <span className={css.glyph} aria-hidden="true">
                {directory
                  ? (open
                    ? <IconFolderOpenRegular size={15} />
                    : <IconFolderCloseRegular size={15} />)
                  : <IconCodeOutlineRegular size={15} />}
              </span>
              <span className={css.name}>{row.name}</span>
              {directories.get(row.path)?.status === 'loading' && <span className={css.rowStatus} aria-hidden="true" />}
            </div>
          )
        })}
      </div>

      {request !== null && (
        <div className={css.prompt}>
          <input
            className={css.input}
            autoFocus
            value={draft}
            aria-label={request.kind === 'file' ? t('files.createFile.title') : t('files.createFolder.title')}
            placeholder={t('files.name.placeholder')}
            disabled={busy}
            onChange={(event) => { setDraft(event.target.value); setNotice(null) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); void submitCreate() }
            }}
          />
          <button type="button" className={css.promptAction} disabled={busy || draft.trim() === ''} onClick={() => { void submitCreate() }}>
            {t('files.create')}
          </button>
          <button type="button" className={css.promptAction} disabled={busy} onClick={() => { setRequest(null) }}>
            {t('files.cancel')}
          </button>
        </div>
      )}

      {notice !== null && <div className={css.notice} role="status">{notice}</div>}

      {menu !== null && (
        <div className={css.menu} role="menu" style={{ left: menu.left, top: menu.top }}>
          {menu.row.type !== 'directory' && openFile !== undefined && (
            <button
              type="button"
              role="menuitem"
              className={css.menuItem}
              onClick={() => { openFile?.(sessionId, menu.row.path); setMenu(null) }}
            >
              {t('files.open')}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className={css.menuItem}
            onClick={() => { void navigator.clipboard.writeText(menu.row.path); setNotice(t('files.copied')); setMenu(null) }}
          >
            {t('files.copyPath')}
          </button>
          <div className={css.menuSeparator} role="separator" />
          <button
            type="button"
            role="menuitem"
            className={css.menuItem}
            onClick={() => { beginCreate({ kind: 'file', parent: createParent(menu.row) }) }}
          >
            {menu.row.type === 'directory' ? t('files.newFileHere') : t('files.newFile')}
          </button>
          <button
            type="button"
            role="menuitem"
            className={css.menuItem}
            onClick={() => { beginCreate({ kind: 'directory', parent: createParent(menu.row) }) }}
          >
            {menu.row.type === 'directory' ? t('files.newFolderHere') : t('files.newFolder')}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Turn a create rejection into copy. The code is read structurally: a client
 * plugin bundle does not share error-class identity with the Host.
 */
function createFailure(
  error: unknown, t: WorkspaceFileTreeProps['t'], name: string,
): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (code === 'workspace-file/already-exists') return t('files.conflict', { name })
  if (code === 'workspace-file/denied') return t('files.denied')
  return error instanceof Error ? error.message : String(error)
}

export default WorkspaceFileTree
