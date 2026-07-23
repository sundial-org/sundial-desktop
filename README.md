# Sundial

[Website](https://www.sundial.md) | [Blog](https://www.sundial.md/blog) | [Docs](https://www.sundial.md/docs) | [X](https://x.com/sundialhub)

Sundial is a markdown editor built for your writing experience first, while staying agent-native. It balances privacy-preserving local editing with collaborative sharing of a single file or a full project. It is flexible to use with any agent — and Sundial itself is customizable with any agent :)

It is free forever — only pay per-use for Sundial's agent, or use your own.

![Sundial — a local Claude Code turn proposing reviewable edits](screenshot.png)

*Your own Claude Code, running locally, proposing edits you accept or reject line by line.*

- **Bring your own agent** — Claude Code and Codex run on your machine, on your subscription, right inside the editor
- **Every edit reviewable** — track changes built for agents: attributed suggestions with inline accept/reject, at any granularity
- **History at edit granularity** — not commit granularity
- **Real documents** — Markdown first; LaTeX with live preview and citations; notebooks that run
- **Local-first** — plain files on disk, works offline, no account needed
- **One workspace everywhere** — sign in to share, edit multiplayer, and reach the same workspace from web, iMessage, or Slack, with Sunny (Sundial's hosted agent) as another collaborator

## Get started

- **Use the desktop app** → [Download](https://www.sundial.md/download) — free forever, latest macOS
- **Build it from source** → [Build](#build)
- **Want to contribute?** → [Issues](https://github.com/sundial-org/sundial-desktop/issues)
- **Have a bug or feature request?** → [Add it here](https://github.com/sundial-org/sundial-desktop/issues/new)

## Philosophy

Sundial is meant to improve communication — increase bits per second of information.

- **Minimal**
- **Fast**
- **Intentional balance of privacy and collaboration**
- **Flexible**
- **Agent-native**
- **Self-improving**
- **Built for human understanding** — learn, retain, retrieve
- **Energize** — amplify your intuition with the power of the sun

## Inspirations

Obsidian, Notion, VSCode, and Google Docs are all inspirations. Sundial will feel familiar if you use any of these.

## Build

Requires Node ≥ 23, pnpm 10, and (for the shell) the Rust toolchain.

```bash
pnpm install
(cd agent-ts && pnpm install)   # Claude Agent SDK for the local engine
(cd tauri && pnpm install)
cd tauri && pnpm tauri build
```

`pnpm exec next build desktop-ui` builds just the UI;
`node local-server/server.mjs` runs the sidecar against a repo checkout.

This repo is the local-first heart of Sundial: the desktop shell, the sidecar,
the editor, the CRDT doc engine, and the local agent engines. Signing in
connects the same app to Sundial's hosted side — sharing, multiplayer, Sunny.

## Contributing

Contributions are welcome — bug reports, fixes, features, ideas. Open an
issue or send a PR. We review everything here, and merged changes ship in
the next release with your authorship preserved. Planning something bigger?
Open an issue first and we'll help you scope it.

## License

[Apache-2.0](LICENSE). "Sundial" and the Sundial logo are trademarks of
Long Horizon Research, Inc.; the license does not grant trademark rights.
