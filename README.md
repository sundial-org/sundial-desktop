<!--
Hero framing: "Real-time multiplayer AI workspace". Self-improvement
(nightly reflection, memory/skills) is deliberately NOT mentioned here; it
ships as its own later release. This file is the source of truth and is
ported to scripts/oss/README.md in the monorepo so exports keep it.
-->

# Sundial Desktop

<!-- The release badge renders once the repo is public and has a GitHub release. -->
[![Release](https://img.shields.io/github/v/release/sundial-org/sundial-desktop)](https://github.com/sundial-org/sundial-desktop/releases) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE) [![X](https://img.shields.io/badge/X-@sundialmd-black)](https://x.com/sundialmd)

**Real-time multiplayer AI workspace.**

A Markdown editor where your team and your agents work together in real time. Claude Code and Codex join your documents as live collaborators, on the subscriptions you already pay for. Every edit by anyone, human or agent, is attributed and reviewable. And it is local by default: files and agents live on your machine, and nothing syncs until you share.

[Download for macOS](https://www.sundial.md/download) · [Web app](https://www.sundial.md) · [Docs](https://www.sundial.md/docs) · [Blog](https://www.sundial.md/blog) · [X](https://x.com/sundialmd)

<!-- HERO (todo): replace screenshot.png with demo.gif (~15s) of the
comment-delegation flow: select text, comment "@Agent tighten this section",
agent replies in the thread, its edit appears inline as a pending suggestion,
user accepts it; at least two live cursors visible (one human, one agent). -->
![Delegating an edit to the agent from a comment thread in a shared Sundial doc](screenshot.png)

*Select text, comment, tag the agent. The fix comes back as a suggestion you accept or reject.*

## What you get

- **Multiplayer for agents.** Your teammates' cursors and their agents' edits appear in the doc as they happen, attributed to whoever made them, human or agent.
- **Your subscription works here.** Claude Code and Codex run on your machine, inside the editor. No API key, no per-token markup, no account until you share.
- **Comment to delegate.** Select a paragraph, comment `@Agent shorten this`, and the agent answers in the thread; its fix lands as a suggestion on exactly that selection. Comments work between people too.
- **Track changes, built for agents.** Every edit by anyone, human or agent, is attributed, with inline accept/reject and history at edit granularity, not commit granularity.
- **Writing that compiles.** Markdown first; LaTeX with live PDF preview and notebooks that run are first-class too.
- **Any model.** Local engines run on your subscriptions; signed in, swap between frontier and open models mid-conversation.
- **Local by default.** Plain files on your disk, agents on your machine. Nothing syncs until you share a doc; share and it syncs live through our cloud; stop sharing and you are fully local again. Works offline.

## How it works

Documents are CRDTs (Yjs), so agents and people edit the same doc concurrently without conflicts, and every keystroke carries attribution. A Tauri shell hosts the editor; a local sidecar watches your folders and drives the agent engines (Claude Code and Codex through their own harnesses, on your login). Agent output streams into the doc as tracked, reviewable changes rather than file overwrites. Sharing syncs the same CRDT through a sync server; the doc engine, the review model, and the agent engines in this repo are the product, not a wrapper around a CLI.

## Compared to what you use now

|                                        | Sundial | Claude Code / Cursor | Google Docs / Notion | Obsidian |
| -------------------------------------- | :-----: | :------------------: | :------------------: | :------: |
| Live multiplayer docs                  | ✓       | ✗                    | ✓                    | ✗        |
| Agents as live collaborators           | ✓       | single-player        | ✗                    | ✗        |
| Local agents on your own subscription  | ✓       | ✓                    | ✗                    | plugins  |
| Per-edit review of agent work          | ✓       | commit-level         | ✗                    | ✗        |
| Local-first, open source               | ✓       | ✗                    | ✗                    | files only |

## Security model

- Agents propose; you decide. Agent writes land as suggestions with inline review, and full edit history means anything is revertable.
- Your files are plain markdown on your disk. Nothing leaves your machine until you share a file or folder, and sharing is scoped to exactly what you picked.

## FAQ

**Does my data leave my machine?** Not until you share. In a local project, files and agent runs stay on disk. Sharing a doc syncs that doc through our cloud; everything else stays local.

**Do I need an API key?** No. Sundial drives the Claude Code and Codex you already have, on your existing plan. Signed in, you can also use hosted models with no key.

**Can I use my Claude Max or ChatGPT plan?** Yes, that is the default: local engines run on your own login and subscription.

**What works offline?** Editing, review, and history, fully. Agent turns need your model provider reachable; sharing and hosted models need Sundial's cloud.

## Install

**macOS** — [download the app](https://www.sundial.md/download), drag it to Applications, open it. Free, no account needed.

**Windows / Linux** — not built yet, tracked in [issues](https://github.com/sundial-org/sundial-desktop/issues); a star helps us prioritize.

**From source** — see [Build](#build).

## Try it in 60 seconds

1. Open Sundial and point it at any folder of markdown, or start empty.
2. Select a sentence and comment `@Agent make this tighter`.
3. The agent replies in the thread and its edit shows up inline as a suggestion. Accept or reject it.
4. Share the doc with a teammate: their cursor, and their agent's edits, appear live.

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

This repo is the local-first heart of Sundial: the desktop shell, the sidecar, the editor, the CRDT doc engine, and the local agent engines. Everything local runs with no account and no server. Signing in connects the same app to Sundial's hosted side: sharing, multiplayer sync, and Sundial's hosted agent. Sync speaks standard Hocuspocus/Yjs; if you want to self-host it, open an issue and we will help.

## Philosophy

Minimal, fast, and intentional about the line between what stays private and what you share. Sundial exists to raise the bits per second between you, your team, and your agents.

## Acknowledgements

Sundial stands on [Yjs](https://github.com/yjs/yjs), [Tiptap](https://github.com/ueberdosis/tiptap)/[ProseMirror](https://prosemirror.net), [Hocuspocus](https://github.com/ueberdosis/hocuspocus), [Tauri](https://tauri.app), the [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk/overview), and [pdf.js](https://mozilla.github.io/pdf.js/).

## Contributing

Contributions are welcome: bug reports, fixes, features, ideas. Open an issue or send a PR. We review everything here, and merged changes ship in the next release with your authorship preserved. Planning something bigger? Open an issue first and we will help you scope it.

If Sundial is useful to you, a star helps other people find it.

## Community

[X @sundialmd](https://x.com/sundialmd) for what we're building · [Issues](https://github.com/sundial-org/sundial-desktop/issues) for bugs and ideas.
<!-- TODO: add the Discord invite here once a public server exists. -->

## License

[Apache-2.0](LICENSE). "Sundial" and the Sundial logo are trademarks of Long Horizon Research, Inc.; the license does not grant trademark rights.
