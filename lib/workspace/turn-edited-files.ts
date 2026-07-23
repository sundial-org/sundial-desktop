/**
 * "Edited in this response" — the files changed by the LATEST chat turn.
 *
 * A turn is the run of assistant messages after the most recent user message.
 * The boundary is computed from the SAME message array that's scanned, so a
 * stale REST-derived index can never slice a live array at the wrong spot and
 * bleed the previous turn's files into a follow-up that made no edits.
 */
export type TurnEdit = { assistantMessageId: string; filePaths: string[] };
export type TurnMessage = { id?: string | null; role?: string | null };
export type TurnPartMessage = TurnMessage & { parts?: readonly unknown[] | null };

export function editedFilesForLatestTurn(
  messages: readonly TurnMessage[],
  turns: readonly TurnEdit[],
  isExcludedPath: (path: string) => boolean = () => false,
): string[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return [];

  const turnAssistantIds = new Set<string>();
  for (let i = lastUserIdx + 1; i < messages.length; i += 1) {
    const message = messages[i];
    if (message?.role === 'assistant' && message.id) turnAssistantIds.add(message.id);
  }
  if (turnAssistantIds.size === 0) return [];

  const seen = new Set<string>();
  const paths: string[] = [];
  for (const turn of turns) {
    if (!turnAssistantIds.has(turn.assistantMessageId)) continue;
    for (const filePath of turn.filePaths) {
      if (seen.has(filePath) || isExcludedPath(filePath)) continue;
      seen.add(filePath);
      paths.push(filePath);
    }
  }
  return paths;
}

// Editing tools whose `input.file_path` names the file they changed. Covers
// the cloud Tier-1 tools and both local engines (Claude Code / Codex run the
// same Write/Edit tool surface through the sidecar DocHost).
const EDIT_TOOL_NAMES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function editToolFilePath(part: unknown): string | null {
  if (!part || typeof part !== 'object') return null;
  const { type, toolName, state, input, output } = part as {
    type?: unknown; toolName?: unknown; state?: unknown; input?: unknown; output?: unknown;
  };
  if (typeof type !== 'string') return null;
  const name = type === 'dynamic-tool' ? toolName : type.startsWith('tool-') ? type.slice(5) : null;
  if (typeof name !== 'string' || !EDIT_TOOL_NAMES.has(name)) return null;
  // Only edits that actually applied — a streaming/denied/failed call didn't
  // change the file, so it shouldn't pull the editor open. Application-level
  // failures (e.g. "old_string not found") still stream as output-available
  // with an error payload, so inspect the output too.
  if (state !== 'output-available') return null;
  if (output && typeof output === 'object') {
    const flags = output as { isError?: unknown; is_error?: unknown };
    if (flags.isError === true || flags.is_error === true) return null;
  }
  if (typeof output === 'string' && /^\s*error\b/i.test(output)) return null;
  const filePath = (input as { file_path?: unknown } | null | undefined)?.file_path;
  return typeof filePath === 'string' && filePath.trim() ? filePath.trim() : null;
}

/**
 * Fallback edit signal read straight from the latest turn's tool parts, for
 * chats with no `doc_edits` plumbing (local-engine chats). Same turn boundary
 * as `editedFilesForLatestTurn`; paths are whatever the tool was called with
 * (may be absolute for local engines — resolve against the file tree).
 */
export function editedPathsFromLatestTurnToolParts(messages: readonly TurnPartMessage[]): string[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return [];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (let i = lastUserIdx + 1; i < messages.length; i += 1) {
    const message = messages[i];
    if (message?.role !== 'assistant') continue;
    for (const part of message.parts ?? []) {
      const filePath = editToolFilePath(part);
      if (filePath && !seen.has(filePath)) {
        seen.add(filePath);
        paths.push(filePath);
      }
    }
  }
  return paths;
}

/**
 * Resolve a tool-reported path (workspace-relative, "/"-prefixed, or absolute
 * from a local engine) to a real row in the file tree: exact match after
 * stripping leading slashes, else the LONGEST path-suffix match — for a file
 * under the project root its relative path is a suffix of the absolute one,
 * and the longest match is the most specific (a shorter one is a same-name
 * file higher in the tree).
 */
export function resolveEditedPathToWorkspacePath(
  candidate: string,
  hasPath: (path: string) => boolean,
  allPaths: () => Iterable<string>,
): string | null {
  // Windows local engines report separator-of-the-OS paths (src\draft.md,
  // C:\Users\...) and tools accept "./draft.md" forms; the workspace tree is
  // always "/"-normalized with no dot segments.
  const normalized = candidate
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '.')
    .join('/');
  const stripped = normalized.replace(/^([A-Za-z]:)?\/+/, '');
  if (hasPath(stripped)) return stripped;
  // Suffix matching is for ABSOLUTE (local-engine) paths only. A relative
  // path that isn't in the tree yet is a just-created file the tree hasn't
  // refreshed for — resolving it to a same-named existing file elsewhere
  // would open the wrong document; return null and let the caller retry
  // when the tree updates.
  if (!/^([A-Za-z]:)?\//.test(normalized)) return null;
  let match: string | null = null;
  for (const path of allPaths()) {
    if (!stripped.endsWith(`/${path}`)) continue;
    if (!match || path.length > match.length) match = path;
  }
  return match;
}
