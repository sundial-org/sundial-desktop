/**
 * The one source of the CLI connect commands for the hosted MCP server —
 * rendered by onboarding's agent step and the workspace connector modal, so
 * the recipe can't drift between the two.
 */
export function buildMcpConnectUrl(origin: string, projectId?: string | null) {
  // Scoping the connection to a workspace makes the agent land there (and
  // register presence) without first calling sundial_list_workspaces.
  return `${origin}/mcp${projectId ? `?workspace=${encodeURIComponent(projectId)}` : ''}`;
}

export function buildMcpCliCommands(mcpUrl: string) {
  // Quote the URL — the `?`/`&` trip up zsh/bash without it.
  return {
    claudeCode: `claude mcp add --transport http sundial "${mcpUrl}" && claude mcp login sundial`,
    codex: `codex mcp add sundial --url "${mcpUrl}" && codex mcp login sundial`,
  };
}
