/**
 * The `createFile`, `createDirectory` and `renameEntry` endpoints: the
 * namespace's only mutations. The creates are create-if-absent and a rename
 * changes one segment, so every case here checks either that the tree gained
 * exactly the requested entry or that the call was refused without touching what
 * was already there.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { failureOf, openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness
let workspace: string
let outside: string

beforeEach(async () => {
  harness = await openWorkspace('dsh-workspace-files-create-')
  workspace = harness.workspace
  outside = harness.outside
})

afterEach(async () => {
  await harness.dispose()
})

/**
 * The absolute path the backend reports for a path, resolved through the
 * filesystem: a temp root can itself be a link, so the raw `join` is not
 * guaranteed to equal the resolved target path.
 */
const resolved = async (path: string): Promise<string> =>
  harness.ctx.fs.processPath(await harness.ctx.fs.resolve(path))

describe('workspaceFiles.createFile', () => {
  it('creates the file with its content and reports path, version, and size', async () => {
    const created = await harness.endpoint().createFile(harness.scope, 'notes.md', '# hi', signal())
    expect(created.absolutePath).toBe(await resolved(join(workspace, 'notes.md')))
    expect(created.version.length).toBeGreaterThan(0)
    expect(created.bytes).toBe(4)
    expect(await readFile(join(workspace, 'notes.md'), 'utf8')).toBe('# hi')
  })

  it('creates into a nested existing directory and accepts an absolute workspace path', async () => {
    await mkdir(join(workspace, 'src'))
    const created = await harness.endpoint().createFile(harness.scope, join(workspace, 'src', 'a.ts'), 'export {}', signal())
    expect(created.absolutePath).toBe(await resolved(join(workspace, 'src', 'a.ts')))
    expect(await readFile(join(workspace, 'src', 'a.ts'), 'utf8')).toBe('export {}')
  })

  it('refuses a path that already holds a file, leaving its content untouched', async () => {
    await writeFile(join(workspace, 'taken.txt'), 'original', 'utf8')
    const failure = await failureOf(harness.endpoint().createFile(harness.scope, 'taken.txt', 'replacement', signal()))
    expect(failure.code).toBe('workspace-file/already-exists')
    expect(failure.details).toMatchObject({ path: 'taken.txt' })
    expect(await readFile(join(workspace, 'taken.txt'), 'utf8')).toBe('original')
  })

  it('refuses a path that holds a directory', async () => {
    await mkdir(join(workspace, 'dir'))
    const failure = await failureOf(harness.endpoint().createFile(harness.scope, 'dir', 'x', signal()))
    expect(failure.code).toBe('workspace-file/already-exists')
  })

  it('refuses a path outside the workspace and leaves no file behind', async () => {
    const failure = await failureOf(harness.endpoint().createFile(harness.scope, join(outside, 'escape.txt'), 'x', signal()))
    expect(failure.code).toBe('workspace-file/outside-workspace')
    expect(failure.details).toMatchObject({ path: join(outside, 'escape.txt') })
    await expect(stat(join(outside, 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an empty path before resolving anything', async () => {
    const failure = await failureOf(harness.endpoint().createFile(harness.scope, '', 'x', signal()))
    expect(failure.code).toBe('gateway/bad-request')
  })

  it('enforces the configured file byte cap', async () => {
    const failure = await failureOf(
      harness.endpoint({ maxFileBytes: 4 }).createFile(harness.scope, 'big.txt', '12345', signal()),
    )
    expect(failure.code).toBe('workspace-file/too-large')
    await expect(stat(join(workspace, 'big.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('workspaceFiles.createDirectory', () => {
  it('creates missing parents and reports the new absolute path', async () => {
    const created = await harness.endpoint().createDirectory(harness.scope, 'a/b/c', signal())
    expect(created.absolutePath).toBe(await resolved(join(workspace, 'a', 'b', 'c')))
    expect((await stat(join(workspace, 'a', 'b', 'c'))).isDirectory()).toBe(true)
  })

  it('refuses a path that already holds a directory rather than adopting it', async () => {
    await mkdir(join(workspace, 'there'))
    const failure = await failureOf(harness.endpoint().createDirectory(harness.scope, 'there', signal()))
    expect(failure.code).toBe('workspace-file/already-exists')
    expect(failure.details).toMatchObject({ path: 'there' })
  })

  it('refuses a path that already holds a file', async () => {
    await writeFile(join(workspace, 'file.txt'), 'x', 'utf8')
    const failure = await failureOf(harness.endpoint().createDirectory(harness.scope, 'file.txt', signal()))
    expect(failure.code).toBe('workspace-file/already-exists')
  })

  it('refuses a path outside the workspace and creates nothing', async () => {
    const failure = await failureOf(harness.endpoint().createDirectory(harness.scope, join(outside, 'escape'), signal()))
    expect(failure.code).toBe('workspace-file/outside-workspace')
    await expect(stat(join(outside, 'escape'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an empty path before resolving anything', async () => {
    const failure = await failureOf(harness.endpoint().createDirectory(harness.scope, '', signal()))
    expect(failure.code).toBe('gateway/bad-request')
  })
})

describe('workspaceFiles.renameEntry', () => {
  it('renames an entry inside its own directory, keeping its content', async () => {
    await mkdir(join(workspace, 'docs'))
    await writeFile(join(workspace, 'docs', 'before.md'), 'body', 'utf8')
    const renamed = await harness.endpoint().renameEntry(harness.scope, 'docs/before.md', 'after.md', signal())
    expect(renamed.absolutePath).toBe(await resolved(join(workspace, 'docs', 'after.md')))
    expect(await readFile(join(workspace, 'docs', 'after.md'), 'utf8')).toBe('body')
    await expect(stat(join(workspace, 'docs', 'before.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('renames a directory with its contents', async () => {
    await mkdir(join(workspace, 'old'))
    await writeFile(join(workspace, 'old', 'inner.md'), 'inner', 'utf8')
    await harness.endpoint().renameEntry(harness.scope, 'old', 'new', signal())
    expect(await readFile(join(workspace, 'new', 'inner.md'), 'utf8')).toBe('inner')
  })

  it('refuses a name that is not a single path segment', async () => {
    await writeFile(join(workspace, 'a.md'), 'x', 'utf8')
    for (const name of ['sub/a.md', 'sub\\a.md', '', '..']) {
      const failure = await failureOf(harness.endpoint().renameEntry(harness.scope, 'a.md', name, signal()))
      expect(failure.code).toBe('gateway/bad-request')
    }
    expect(await readFile(join(workspace, 'a.md'), 'utf8')).toBe('x')
  })

  it('refuses an occupied destination, leaving both entries alone', async () => {
    await writeFile(join(workspace, 'a.md'), 'A', 'utf8')
    await writeFile(join(workspace, 'b.md'), 'B', 'utf8')
    const failure = await failureOf(harness.endpoint().renameEntry(harness.scope, 'a.md', 'b.md', signal()))
    expect(failure.code).toBe('workspace-file/already-exists')
    expect(await readFile(join(workspace, 'a.md'), 'utf8')).toBe('A')
    expect(await readFile(join(workspace, 'b.md'), 'utf8')).toBe('B')
  })

  it('refuses a source that is not there', async () => {
    const failure = await failureOf(harness.endpoint().renameEntry(harness.scope, 'absent.md', 'next.md', signal()))
    expect(failure.code).toBe('workspace-file/not-found')
  })

  it('refuses an entry outside the workspace', async () => {
    const failure = await failureOf(
      harness.endpoint().renameEntry(harness.scope, join(outside, 'escape.md'), 'next.md', signal()),
    )
    expect(failure.code).toBe('workspace-file/outside-workspace')
  })
})

describe('workspaceFiles.write', () => {
  it('replaces a file under the version its reader saw', async () => {
    await writeFile(join(workspace, 'edit.md'), 'before', 'utf8')
    const read = await harness.endpoint().read(harness.scope, 'edit.md', {}, signal())
    const written = await harness.endpoint().write(harness.scope, 'edit.md', 'after', read.version, signal())
    // A new version, because the bytes changed: the next write's basis.
    expect(written.version).not.toBe(read.version)
    expect(await readFile(join(workspace, 'edit.md'), 'utf8')).toBe('after')
  })

  it('refuses a write whose basis moved, leaving the other writer\'s bytes alone', async () => {
    await writeFile(join(workspace, 'race.md'), 'first', 'utf8')
    const read = await harness.endpoint().read(harness.scope, 'race.md', {}, signal())
    // Someone else — the agent, another surface, this reader in another window —
    // writes it. The editor's basis is stale from here on.
    await writeFile(join(workspace, 'race.md'), 'theirs', 'utf8')
    const failure = await failureOf(
      harness.endpoint().write(harness.scope, 'race.md', 'mine', read.version, signal()),
    )
    expect(failure.code).toBe('workspace-file/stale-version')
    expect(await readFile(join(workspace, 'race.md'), 'utf8')).toBe('theirs')
  })

  it('writes unconditionally when the caller names no version', async () => {
    await writeFile(join(workspace, 'plain.md'), 'old', 'utf8')
    await harness.endpoint().write(harness.scope, 'plain.md', 'new', undefined, signal())
    expect(await readFile(join(workspace, 'plain.md'), 'utf8')).toBe('new')
  })
})

describe('workspaceFiles.deleteEntry', () => {
  it('deletes a file and reports what it was', async () => {
    await writeFile(join(workspace, 'gone.md'), 'x', 'utf8')
    expect(await harness.endpoint().deleteEntry(harness.scope, 'gone.md', signal())).toEqual({ kind: 'file' })
    await expect(stat(join(workspace, 'gone.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('deletes a directory with its contents', async () => {
    await mkdir(join(workspace, 'tree', 'inner'), { recursive: true })
    await writeFile(join(workspace, 'tree', 'inner', 'a.md'), 'a', 'utf8')
    expect(await harness.endpoint().deleteEntry(harness.scope, 'tree', signal())).toEqual({ kind: 'directory' })
    await expect(stat(join(workspace, 'tree'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a link rather than removing what it points at', async () => {
    await writeFile(join(workspace, 'real.md'), 'body', 'utf8')
    await symlink(join(workspace, 'real.md'), join(workspace, 'link.md'))
    const failure = await failureOf(harness.endpoint().deleteEntry(harness.scope, 'link.md', signal()))
    expect(failure.code).toBe('workspace-file/not-regular-file')
    expect(failure.details).toMatchObject({ path: 'link.md', kind: 'symlink' })
    // The refusal is the point: the link's target is untouched.
    expect(await readFile(join(workspace, 'real.md'), 'utf8')).toBe('body')
  })

  it('refuses a missing target and an entry outside the workspace', async () => {
    const missing = await failureOf(harness.endpoint().deleteEntry(harness.scope, 'absent.md', signal()))
    expect(missing.code).toBe('workspace-file/not-found')
    const escaped = await failureOf(
      harness.endpoint().deleteEntry(harness.scope, join(outside, 'escape.md'), signal()),
    )
    expect(escaped.code).toBe('workspace-file/outside-workspace')
  })
})
