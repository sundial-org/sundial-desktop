// Runtime re-export of the Claude Agent SDK for the desktop sidecar's local
// Claude engine (local-server/agent/claude-runner.mjs). The sidecar has no
// package.json of its own; importing the SDK through this file makes Node
// (and the prepare-sidecar esbuild bundle) resolve the bare specifier from
// agent-ts/node_modules, keeping the dependency pinned in one place.
export { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
