# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

> **This repository is a modified fork of DeepSeek Harness.** It is not published by, endorsed by, or affiliated
> with DeepSeek AI. Upstream project: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
> The original copyright notice is kept in [LICENSE](LICENSE); the changes made here are described below and in the
> commit history. Links to upstream documentation, Discussions, and Discord below refer to the upstream project.

## What this build does

This fork keeps the upstream **everything-is-a-plugin** agent harness and ships it as a **desktop application**, with
the work focused on the parts a person actually uses while an agent works beside them.

**Desktop application**

- A packaged Electron app for Windows (`pnpm run package:desktop:win:x64:unsigned` produces an NSIS installer, plus an
  unpacked portable build). The app bundles its own runtime, so a recipient installs it and runs it — no Node.js needed.
- The same UI is available as a Web UI (`pnpm dsh web`), which remains the quickest way to try the harness.

**Workspaces, sessions, and files**

- Workspaces with their own session lists. A workspace's row answers a **right-click** with the same menu the ellipsis
  opens: rename, copy the workspace path, **open the workspace directory in the OS file manager**, delete.
- A per-workspace file tree with the usual file operations (open, rename, create, delete, copy relative/absolute path),
  and drag-and-drop of a real file out of the tree into another application.

**The right-hand panel**

The column beside the conversation holds the material the work is about, one tab per kind of material: files, document
preview, the browser, plans, change review, scheduled tasks, and a terminal. Tabs stay mounted while you work on
something else, so switching back does not reload what you were reading.

**Editing files where they live**

- A document opened in the preview **is editable in place**: `编辑` turns the reader into an editor, `Ctrl + S` (or
  `Cmd + S`) writes the buffer back, and the tab grows the dot an editor shows for unsaved work. Closing a tab with
  unsaved changes asks first, and offers "save and close" rather than dropping the work.
- Saving carries the version the text was read at, so a file that changed underneath you is a decision — keep my
  changes, or take the file — never a silent overwrite.
- Spreadsheets open in a grid and are edited and saved the same way, one patch per save rather than a full
  re-serialization; a workbook holding something the writer would drop stays read-only instead of losing it.
- A text editor without a find bar is a toy, so the editor has find and replace (`查找 / 替换`) over the same buffer it
  saves.
- **`Shift + Space` quotes the selection into the composer.** Select a paragraph in a document, or text in the browser,
  and the keys put it into the conversation as a quote — from the editor's own selection too, not only from a page.

**The built-in browser (the 「网页」 view)**

- A browser inside the app that an agent can drive with the same tools it uses elsewhere: list open pages, select a
  page, navigate, run script in a page, take screenshots, read console and network traffic. Pages are addressed by
  position, and a page the reader is looking at is distinct from a page that merely exists.
- Pages identify as a plain Chrome to the sites that ask, rather than revealing the application's engine, because a
  great many sites refuse anything else.
- Ctrl+wheel zooms the page and the zoom announces itself with a way back; tabs survive switching between the
  conversation and the browser; the view reopens the last page it was on after a reload or a restart.
- Every guest page is torn down and recreated by the application, not by the site, and the host records why
  (release, destruction, renderer crash) so that a page loss can be diagnosed instead of merely noticed.

**Tools and skills**

- Agent tools for files, shells (bash and PowerShell), the web, and the built-in browser.
- Documents as first-class material: reading, generating, rendering, splitting and merging Word documents through the
  bundled Word tooling, and Office conversions through the bundled LibreOffice-based runtime.
- A plugin system, so features above can be added, replaced, or removed without a fork.

**Status**

Developer preview: interfaces and behavior still change, and compatibility-breaking changes are expected.


## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a checkout of **this** repository (`Node.js >= 22.19`, `pnpm 11.7`):

```sh
git clone https://github.com/alextomdog/harness-desktop.git
cd harness-desktop
corepack pnpm install --no-frozen-lockfile
corepack pnpm run build:lib
corepack pnpm run build:web
```

`--no-frozen-lockfile` matters here: a dependency was added to a workspace package and the lockfile in this fork is kept
in step by the install itself. A frozen install can refuse that mismatch and leave a workspace dependency unlinked,
which later fails during packaging with an unresolved `workspace:` specifier.

Run the **Web UI** with the built artifacts:

```sh
corepack pnpm dsh web
```

Run the **desktop application** from source (it rebuilds the shells it needs and starts the app):

```sh
cd apps/desktop
corepack pnpm run dev
```

Build a Windows installer (see [Run](#run) for the portable result too):

```sh
cp .env.windows.example .env.windows   # fill in the local release settings
corepack pnpm run package:desktop:win:x64:unsigned
```

The packaging pipeline expects the release settings above (update/policy origins included); an unsigned local build can
use placeholder `https://` origins, at the cost of a non-functional updater.

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/4MrtZUhpxg">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

`pnpm run dev:web` builds, serves, and rebuilds client bundles on source edits in one terminal, and `make help` lists the matching Make targets for Web and Desktop; the guide's application commands section owns the full table.

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
