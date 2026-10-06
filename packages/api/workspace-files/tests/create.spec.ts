/**
 * The `createFile` and `createDirectory` endpoints: the namespace's only
 * mutations. Both are create-if-absent and workspace-scoped, so every case here
 * checks either that the tree gained exactly the requested entry or that the
 * call was refused without touching what was already there.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
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
