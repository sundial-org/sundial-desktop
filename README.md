# Sundial Desktop

The open-source desktop app behind [sundial.md](https://www.sundial.md) — an
agent-native editor where your local agents (Claude Code, Codex) edit
documents alongside you, with every edit attributed and reviewable.

**Everything that runs on your machine is in this repo.** When you work
locally — your files, the editor, the CRDT doc engine, the agent bridge — no
cloud is involved and nothing leaves your computer:

- `tauri/` — the desktop shell (Rust, Tauri v2)
- `local-server/` — the sidecar: local file serving, SQLite store, CRDT doc
  host (Hocuspocus over your disk), LaTeX compile, and the local agent
  engines that drive your own Claude Code / Codex subscription
- `desktop-ui/` + `app/`, `components/`, `lib/` — the editor surface, a
  static Next.js export served by the sidecar

Sundial's cloud — accounts, sharing, multiplayer sync, the hosted Sunny
agent, iMessage/Slack surfaces — is a separate closed service. The desktop
app works fully without it; signing in connects to it.

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

## Contributing

This repo is exported from Sundial's private monorepo on every release; the
monorepo remains the source of truth. Issues and PRs are welcome — accepted
patches are ported inward and ship in the next export with attribution.

## License

[Apache-2.0](LICENSE). "Sundial" and the Sundial logo are trademarks of
Long Horizon Research, Inc.; the license does not grant trademark rights.
