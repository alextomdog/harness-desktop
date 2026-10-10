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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button, classifyFileType, FileTypeIcon,
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular,
  IconFolderCloseRegular, IconFolderOpenRegular, IconPlusOutlineRegular,
  IconProjectAddOutlineRegular, IconRefreshOutlineRegular, Modal,
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
   * Rename one entry in place, changing its last path segment. Optional: a
   * composition without it offers no rename rather than a dead item.
   */
  renameEntry?: (sessionId: SessionId, path: string, name: string, signal: AbortSignal) => Promise<void>
  /**
   * Delete one entry, taking a folder's contents with it. Optional, like the
   * rename: a composition without it offers no delete.
   */
  deleteEntry?: (sessionId: SessionId, path: string, signal: AbortSignal) => Promise<void>
  /**
   * Reveal one file in the resource surface that owns file tabs. Optional: a
   * composition without that surface still gets a usable tree — expansion,
   * copy-path and the two creates — instead of a row that looks broken.
   */
  openFile?: (sessionId: SessionId, path: string) => void
}

/** Props of the file-tree entry: the owner share, the locale seat, and its actions. */
export type WorkspaceFileTreeProps =
  & {
    readonly sessionId: SessionId
    /**
     * The Workspace's own root, when the owner knows it. The tree addresses the
     * Host by workspace-relative path, so only the clipboard needs the absolute
     * form composed here.
     */
    readonly workspaceRoot?: string | undefined
  }
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

/**
 * The pending name edit: creating an entry in a directory, or renaming one that
 * is already there. Both go through the same input, so the section has one name
 * editor rather than two.
 */
type NameRequest =
  | {
    readonly kind: 'file' | 'directory'
    /** Workspace-relative directory the new entry lands in; `''` is the workspace root. */
    readonly parent: string
  }
  | {
    readonly kind: 'rename'
    /** Workspace-relative path of the entry being renamed. */
    readonly path: string
    /** Its name now, so the editor opens on the text being replaced. */
    readonly name: string
  }

/** The open row menu, positioned at the pointer. */
interface MenuState {
  readonly row: Row
  readonly left: number
  readonly top: number
}

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
    for (const entry of orderEntries(state.entries)) {
      const entryPath = childPath(path, entry.name)
      rows.push({ path: entryPath, name: entry.name, type: entry.type, depth })
      if (entry.type === 'directory' && expanded.has(entryPath)) visit(entryPath, depth + 1)
    }
  }
  visit('', 0)
  return rows
}

/**
 * Folders before files, each group by name: the Explorer's own order. The Host
 * reports a stable name order, which would interleave a file among the folders.
 */
function orderEntries(entries: readonly WorkspaceTreeEntry[]): readonly WorkspaceTreeEntry[] {
  const group = (entry: WorkspaceTreeEntry): number => entry.type === 'directory' ? 0 : 1
  return [...entries].sort((a, b) => group(a) - group(b) || a.name.localeCompare(b.name))
}

/** Join a workspace-relative path to its root, in that root's own separator style. */
function absolutePath(workspaceRoot: string | undefined, path: string): string {
  if (workspaceRoot === undefined || workspaceRoot === '') return path
  const separator = workspaceRoot.includes('\\') ? '\\' : '/'
  const root = workspaceRoot.replace(/[\\/]+$/u, '')
  return path === '' ? root : `${root}${separator}${path.split('/').join(separator)}`
}

/** The directory holding a workspace path; `''` at the workspace root. */
function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
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
  sessionId, workspaceRoot, t, listDirectory, createFile, createDirectory, renameEntry, deleteEntry, openFile,
}: WorkspaceFileTreeProps) {
  const [directories, setDirectories] = useState<ReadonlyMap<string, DirectoryState>>(new Map())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  /** This section's own fold: the Files level inside a Workspace. */
  const [open, setOpen] = useState(true)
  /** The row a delete is about to remove, while its confirmation is up. */
  const [confirmDelete, setConfirmDelete] = useState<Row | null>(null)
  /**
   * The rows the reader has taken, and the row a shift-click measures from.
   *
   * `selected` remains the ONE row an action would act on — the context menu and rename still
   * mean it — while this is the range the tree highlights. Ctrl adds or removes one, Shift
   * takes the run between the anchor and the row, and a plain click is a selection of one.
   */
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set())
  const anchor = useRef<string | null>(null)
  /**
   * The visible rows, mirrored for the handlers.
   *
   * A row's click reads this to measure a Shift range, and a range measured against a stale list
   * is a range that silently fails to include anything: the anchor is not found and the reader
   * gets a selection of one after asking for a run.
   */
  const rowsRef = useRef<readonly Row[]>([])
  /** The two dismissible surfaces, so an outside-press check can exempt them. */
  const menuRef = useRef<HTMLDivElement | null>(null)
  const promptRef = useRef<HTMLDivElement | null>(null)
  const [request, setRequest] = useState<NameRequest | null>(null)
  /**
   * Set once an inline edit has committed or been cancelled, so the blur that
   * follows its own unmount does not commit a second time.
   */
  const nameSettled = useRef(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // The Session the tree is bound to for its whole life: a re-mount is what
  // re-scopes it, so a late reply from the previous Session cannot land here.
  const lifetime = useRef<AbortController>(new AbortController())

  const load = useCallback(async (path: string, signal: AbortSignal): Promise<void> => {
    // Keep the listing already on screen while the reread is in flight: a refresh
    // or a post-create reload must not blank the tree it is refreshing.
    setDirectories(current => new Map(current).set(path, {
      entries: current.get(path)?.entries ?? [],
      truncated: current.get(path)?.truncated ?? false,
      status: 'loading',
    }))
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

  const allRows = useMemo(() => flatten(directories, expanded), [directories, expanded])
  // Search shows what it matched, wherever it is: filtering the EXPANDED tree would hide every
  // hit inside a folder the reader had closed, which is the one place they are least likely to
  // look. A query therefore flattens everything and keeps the matching rows; an empty query is
  // the tree exactly as the reader left it, collapse and all.
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const matches = query.trim().toLowerCase()
  const rows = useMemo(() => {
    if (matches === '') return allRows
    const everything = new Set(directories.keys())
    return flatten(directories, everything).filter(row => row.name.toLowerCase().includes(matches))
  }, [allRows, matches, directories])
  rowsRef.current = rows
  /** Folding this section empties its rows, the same way folding a group does. */
  const shown = open ? rows : []
  /** The row the inline name editor replaces, when one is open in place. */
  const renaming = request?.kind === 'rename' ? request.path : null

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

  // A menu or prompt closes on an outside press or Escape, so neither can be left
  // stranded over a tree the user has moved on from. A press INSIDE either one is
  // the user acting on it: dismissing on that press would unmount the surface
  // before the click reached the button, so every item would do nothing.
  useEffect(() => {
    if (menu === null && request === null) return
    const close = (): void => { setMenu(null); setRequest(null) }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node
        && (menuRef.current?.contains(target) === true || promptRef.current?.contains(target) === true)) return
      close()
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu, request])

  /** Put one path on the clipboard; a refusal is the browser's to report. */
  const copyPath = useCallback((text: string): void => {
    void navigator.clipboard.writeText(text).catch(() => {})
    setMenu(null)
  }, [])

  const beginCreate = useCallback((next: NameRequest): void => {
    setMenu(null)
    setDraft('')
    setNotice(null)
    setRequest(next)
  }, [])

  /** Open the name editor on an existing row, on the text being replaced. */
  const beginRename = useCallback((row: Row): void => {
    setMenu(null)
    setNotice(null)
    nameSettled.current = false
    setDraft(row.name)
    setRequest({ kind: 'rename', path: row.path, name: row.name })
  }, [])

  // Re-read every directory the tree has already listed, so the refresh control
  // picks up work done outside it without dropping the expansion state.
  const reloadAll = useCallback((): void => {
    for (const path of [...directories.keys()]) void load(path, lifetime.current.signal)
  }, [directories, load])

  const submitCreate = useCallback(async (): Promise<void> => {
    if (request === null) return
    const name = draft.trim()
    if (name === '') return
    setBusy(true)
    try {
      if (request.kind === 'rename') {
        if (renameEntry === undefined) return
        await renameEntry(sessionId, request.path, name, lifetime.current.signal)
        setRequest(null)
        // The holding directory's cached listing now holds the old name.
        await load(parentOf(request.path), lifetime.current.signal)
        return
      }
      const path = childPath(request.parent, name)
      if (request.kind === 'file') await createFile(sessionId, path, '', lifetime.current.signal)
      else await createDirectory(sessionId, path, lifetime.current.signal)
      setRequest(null)
      // The parent's cached listing is now stale; one reload keeps the tree
      // truthful without a watch subscription this section does not own.
      await load(request.parent, lifetime.current.signal)
      if (request.kind === 'directory') {
        // Adopt the new folder as open, WITH its listing: marking it expanded
        // alone would draw an open folder that never loads its children.
        setExpanded(current => new Set(current).add(path))
        await load(path, lifetime.current.signal)
      }
    } catch (error: unknown) {
      setNotice(createFailure(error, t, name))
    } finally {
      setBusy(false)
    }
  }, [createDirectory, createFile, draft, load, renameEntry, request, sessionId, t])

  // Only the very first read has nothing to draw; a reread keeps its rows.
  /**
   * Remove the row the confirmation names. A delete is the one action here that
   * cannot be undone, so it only ever runs from that confirmation.
   */
  const runDelete = useCallback(async (): Promise<void> => {
    if (confirmDelete === null || deleteEntry === undefined) return
    const target = confirmDelete
    setConfirmDelete(null)
    setBusy(true)
    try {
      await deleteEntry(sessionId, target.path, lifetime.current.signal)
      setSelected(null)
      // The holding directory's cached listing now holds the removed name.
      await load(parentOf(target.path), lifetime.current.signal)
    } catch (error: unknown) {
      setNotice(createFailure(error, t, target.name))
    } finally {
      setBusy(false)
    }
  }, [confirmDelete, deleteEntry, load, sessionId, t])

  if (rootState === undefined) {
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
  return (
    <div className={css.root}>
      {/* The section's heading and the tree's title bar in one row: the
          disclosure control and the three actions share it, so the label reads
          as the title of the actions beside it. Always drawn — without it an
          empty Workspace offers no row to right-click, so its root would be
          unreachable, which is how a folder could not be created. */}
      <div className={css.header}>
        <button
          type="button"
          className={css.headerToggle}
          aria-expanded={open}
          onClick={() => { setOpen(current => !current) }}
        >
          {open
            ? <IconChevronDownOutlineRegular size={12} />
            : <IconChevronRightOutlineRegular size={12} />}
          <span>{t('section.files')}</span>
        </button>
        {searching && (
          <input
            ref={searchRef}
            className={css.search}
            data-files-search
            type="search"
            value={query}
            placeholder={t('files.searchPlaceholder')}
            aria-label={t('files.search')}
            onChange={(event) => { setQuery(event.target.value) }}
            onKeyDown={(event) => {
              // Escape is how a reader leaves a search they started by accident.
              if (event.key === 'Escape') { setQuery(''); setSearching(false) }
            }}
          />
        )}
        <span className={css.headerActions}>
          <button
            type="button"
            className={css.toolbarButton}
            aria-label={t('files.search')}
            title={t('files.search')}
            data-files-search-open
            onClick={() => {
              setSearching(true)
              // The field exists only once it is asked for, so the focus waits for the render.
              requestAnimationFrame(() => { searchRef.current?.focus() })
            }}
          >
            {/* An inline magnifier: the icon set this file draws from has no search glyph, and
                borrowing an unrelated one would say the wrong thing about what the button does. */}
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <line x1="10.4" y1="10.4" x2="14" y2="14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className={css.toolbarButton}
            aria-label={t('files.newFile')}
            title={t('files.newFile')}
            onClick={() => { beginCreate({ kind: 'file', parent: '' }) }}
          >
            <IconPlusOutlineRegular size={14} />
          </button>
          <button
            type="button"
            className={css.toolbarButton}
            aria-label={t('files.newFolder')}
            title={t('files.newFolder')}
            onClick={() => { beginCreate({ kind: 'directory', parent: '' }) }}
          >
            <IconProjectAddOutlineRegular size={14} />
          </button>
          <button
            type="button"
            className={css.toolbarButton}
            aria-label={t('files.refresh')}
            title={t('files.refresh')}
            onClick={reloadAll}
          >
            <IconRefreshOutlineRegular size={14} />
          </button>
        </span>
      </div>

      {open && shown.length === 0 && request === null && <div className={css.state}>{t('files.empty')}</div>}

      <div className={css.rows} role="tree" aria-label={t('section.files')}>
        {shown.map((row) => {
          const open = expanded.has(row.path)
          const directory = row.type === 'directory'
          return (
            <div
              key={row.path}
              className={clsx(css.row, selection.has(row.path) && css.multiSelected, selected === row.path && css.selected)}
              role="treeitem"
              data-files-path={row.path}
              data-files-anchor={anchor.current ?? undefined}
              aria-level={row.depth + 1}
              aria-selected={selection.has(row.path)}
              aria-expanded={directory ? open : undefined}
              tabIndex={0}
              // A row offers its PATH, because that is what naming it elsewhere means: the file
              // is already in the workspace, so nothing is uploaded and nothing is copied. A
              // trailing slash is how a folder is named, here and in the mention grammar.
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'copy'
                // Everything the reader has taken travels together. A drag out of a selection says
                // "these", and a lane carrying only the row under the pointer would silently drop
                // the rest of what they chose — one chip where they picked seven.
                const taken = selection.has(row.path)
                  ? rows.filter(candidate => selection.has(candidate.path))
                  : [row]
                event.dataTransfer.setData('text/plain', taken
                  .map(candidate => candidate.type === 'directory' ? `${candidate.path}/` : candidate.path)
                  .join('\n'))
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setRequest(null)
                setSelected(row.path)
                setMenu({ row, left: event.clientX, top: event.clientY })
              }}
              onClick={(event) => {
                // Read off the event NOW, into plain values. The updater below runs during the
                // next render, and a React synthetic event read there has already been released:
                // `event.shiftKey` comes back undefined, the range branch never runs, and a
                // Shift-click silently becomes a click on one row.
                const shift = event.shiftKey
                const toggleOne = event.ctrlKey || event.metaKey
                // The element this click landed on, read NOW for the same reason the keys are: a
                // synthetic event is released by the time the updater below runs.
                const clicked = event.currentTarget as HTMLElement | null
                const extended = shift || toggleOne
                setSelected(row.path)
                setSelection((current) => {
                  if (shift && anchor.current !== null) {
                    // The run is measured over the rows AS RENDERED, read from the DOM: the list a
                    // closure holds can be a render behind, and a range measured against a list
                    // that no longer matches what the reader sees is a range that finds nothing.
                    // Scoped to THIS tree: the sidebar also renders a sessions tree, and its rows
                    // answer to the same role. Measuring across both put the anchor at the wrong
                    // index, so the run was never found and the reader got a selection of one.
                    const tree = clicked?.closest('[role=tree]') ?? null
                    const rendered = [...(tree?.querySelectorAll('[data-files-path]') ?? [])]
                      .map(node => node.getAttribute('data-files-path') ?? '')
                    const from = rendered.indexOf(anchor.current)
                    const to = rendered.indexOf(row.path)
                    if (from === -1 || to === -1) return new Set([row.path])
                    const [start, end] = from <= to ? [from, to] : [to, from]
                    return new Set(rendered.slice(start, end + 1))
                  }
                  if (toggleOne) {
                    const next = new Set(current)
                    if (next.has(row.path)) next.delete(row.path)
                    else next.add(row.path)
                    return next
                  }
                  return new Set([row.path])
                })
                anchor.current = row.path
                // A click that is extending a selection is not also a request to open.
                if (extended) return
                if (directory) toggle(row.path)
                else openFile?.(sessionId, row.path)
              }}
              onKeyDown={(event) => {
                // F2 is the editor's rename gesture; the row acts on its own.
                if (event.key === 'F2') {
                  event.preventDefault()
                  beginRename(row)
                  return
                }
                // Delete asks the same question the menu asks, so the keyboard cannot remove
                // anything the pointer would have had to confirm first.
                if ((event.key === 'Delete' || event.key === 'Backspace') && deleteEntry !== undefined) {
                  if (event.key === 'Backspace' && !directory) return
                  event.preventDefault()
                  setConfirmDelete(row)
                  return
                }
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                setSelected(row.path)
                if (directory) toggle(row.path)
                else openFile?.(sessionId, row.path)
              }}
            >
              {/* One rail per ancestor level, then the twisty, then the entry's
                  glyph: the Explorer's order, so a name's column follows its
                  depth and the rails line up down the tree. */}
              <span className={css.guides} aria-hidden="true">
                {Array.from({ length: row.depth }, (_, level) => (
                  <span key={level} className={css.guide} />
                ))}
              </span>
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
                  : <FileTypeIcon kind={classifyFileType(row.name)} size={15} />}
              </span>
              {/* The rename editor replaces the name in its own row, at that
                  row's indent and beside its glyph — the editor's own gesture,
                  not a separate field below the tree. */}
              {renaming === row.path
                ? (
                  <input
                    className={css.nameInput}
                    autoFocus
                    value={draft}
                    aria-label={t('files.rename')}
                    disabled={busy}
                    onChange={(event) => { setDraft(event.target.value); setNotice(null) }}
                    onFocus={(event) => { event.target.select() }}
                    onClick={(event) => { event.stopPropagation() }}
                    onKeyDown={(event) => {
                      // Keep the row's own keys (Enter opens, Space toggles) out
                      // of the editor's typing.
                      event.stopPropagation()
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        nameSettled.current = true
                        void submitCreate()
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        nameSettled.current = true
                        setRequest(null)
                      }
                    }}
                    onBlur={() => {
                      // Committing on blur is the editor's gesture; the guard
                      // keeps the unmount that follows a commit from repeating it.
                      if (nameSettled.current) return
                      nameSettled.current = true
                      void submitCreate()
                    }}
                  />
                )
                : <span className={css.name}>{row.name}</span>}
              {directories.get(row.path)?.status === 'loading' && <span className={css.rowStatus} aria-hidden="true" />}
              {/* The Explorer puts its two creates on the folder row itself; they
                  stay out of the pointer's way until the row is hovered. */}
              {directory && (
                <span className={css.rowActions}>
                  <button
                    type="button"
                    className={css.rowAction}
                    aria-label={t('files.newFileHere')}
                    title={t('files.newFileHere')}
                    onClick={(event) => {
                      event.stopPropagation()
                      beginCreate({ kind: 'file', parent: row.path })
                    }}
                  >
                    <IconPlusOutlineRegular size={13} />
                  </button>
                  <button
                    type="button"
                    className={css.rowAction}
                    aria-label={t('files.newFolderHere')}
                    title={t('files.newFolderHere')}
                    onClick={(event) => {
                      event.stopPropagation()
                      beginCreate({ kind: 'directory', parent: row.path })
                    }}
                  >
                    <IconProjectAddOutlineRegular size={13} />
                  </button>
                </span>
              )}
            </div>
          )
        })}
      </div>

      {/* Only a create needs this row: a rename edits in place, in its own row. */}
      {request !== null && request.kind !== 'rename' && (
        <div className={css.prompt} ref={promptRef}>
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
        <div className={css.menu} role="menu" ref={menuRef} style={{ left: menu.left, top: menu.top }}>
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
            onClick={() => { copyPath(menu.row.path) }}
          >
            {t('files.copyRelativePath')}
          </button>
          <button
            type="button"
            role="menuitem"
            className={css.menuItem}
            onClick={() => { copyPath(absolutePath(workspaceRoot, menu.row.path)) }}
          >
            {t('files.copyAbsolutePath')}
          </button>
          {renameEntry !== undefined && (
            <button
              type="button"
              role="menuitem"
              className={css.menuItem}
              onClick={() => { beginRename(menu.row) }}
            >
              {t('files.rename')}
            </button>
          )}
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
          {deleteEntry !== undefined && (
            <>
              <div className={css.menuSeparator} role="separator" />
              <button
                type="button"
                role="menuitem"
                className={css.menuItem}
                onClick={() => { setMenu(null); setConfirmDelete(menu.row) }}
              >
                {t('files.delete')}
              </button>
            </>
          )}
        </div>
      )}

      <Modal
        open={confirmDelete !== null}
        onClose={() => { setConfirmDelete(null) }}
        closeLabel={t('files.cancel')}
        title={t('files.delete')}
        footer={(
          <>
            <Button variant="outline" disabled={busy} onClick={() => { setConfirmDelete(null) }}>
              {t('files.cancel')}
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => { void runDelete() }}>
              {t('files.delete')}
            </Button>
          </>
        )}
      >
        <div>{t('files.deleteConfirm', { name: confirmDelete?.name ?? '' })}</div>
      </Modal>
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
