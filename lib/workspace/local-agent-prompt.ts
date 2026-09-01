/**
 * The copy-paste bootstrap an external coding agent (Claude Code, Codex,
 * Cursor) receives to join a Sundial workspace.
 *
 * Optimized for connect latency. The slow part of "connect" is the number of
 * agent reasoning turns, not HTTP — each curl the agent emits is a full
 * inference round-trip, brutal on slow local models. So the ACTIVE paste is the
 * full contract inline, ending in a ONE-CALL handshake: `GET /files` already
 * upserts presence server-side (see local-agent/files/route.ts →
 * bumpLocalAgentPresence), so a single request makes the chip appear AND returns
 * the tree — no second round-trip to fetch instructions first.
 *
 * `buildLocalAgentInstructions` is the single source of that contract. It is
 * pasted inline here AND served at /instructions (app/api/workspace/local-agent/
 * instructions/route.ts) for the SHORTER-paste alternative: a few lines that
 * `curl` the contract instead of inlining it. The short path keeps the agent's
 * chat window tiny at the cost of one extra round-trip — kept wired so we can
 * switch by swapping the one line in `buildLocalAgentJoinPrompt` noted below.
 */
export type LocalAgentPromptInput = {
  appUrl: string;
  workspaceUrl: string;
  token: string;
  projectUuid: string;
  editMode: 'edit' | 'suggest';
};

export type LocalAgentInstructionsInput = Omit<LocalAgentPromptInput, 'workspaceUrl'>;

/**
 * The full agent contract — pasted inline (active) and also served at
 * /instructions for the shorter-paste alternative. Single source of the wording;
 * the join-route test asserts the key lines.
 */
export function buildLocalAgentInstructions({
  appUrl,
  token,
  projectUuid,
  editMode,
}: LocalAgentInstructionsInput): string {
  const base = `${appUrl}/api/workspace/local-agent`;
  const ws = projectUuid;

  const suggestLine =
    editMode === 'suggest'
      ? 'mode    this token is suggest-only — every write lands as a reviewable diff a human accepts/rejects (delete, rename, exec, uploads disabled)'
      : 'suggest writes land as reviewable suggestions by default — add "editMode":"edit" to a write body to apply directly';

  return [
    'Join my Sundial workspace — a live collaborative editor (files, presence, provenance gutters).',
    '',
    'CRITICAL — each shell command runs in a FRESH shell, so environment variables do NOT',
    'persist between commands. Set the token at the START of EVERY command that needs it, on',
    'one line, chained with `&&` — never rely on an `export` from a previous command:',
    '',
    `  export TOKEN="${token}" && curl -sS "${base}/files?workspaceId=${ws}" -H "Authorization: Bearer $TOKEN" -H "X-Agent-Id: ai:<your-agent-name>"`,
    '',
    'That one command connects you: it registers your presence (your chip appears for me) and',
    'returns the file list in the same response — no install, no second call.',
    '',
    'Then reply "Connected in Sundial and ready" and tell me what files you see. Replace',
    '<your-agent-name> with your tool (claude, codex, cursor, gemini). On EVERY call below,',
    'prefix the same `export TOKEN="..." &&` and send `-H "Authorization: Bearer $TOKEN"`',
    '-H "X-Agent-Id: ai:<name>"` — the token is long, so always use the variable, never paste it inline.',
    '',
    'To act (always with the two headers above):',
    `  read    GET  ${base}/file?workspaceId=${ws}&path=<p>`,
    `  search  GET  ${base}/grep?workspaceId=${ws}&pattern=<regex>   (server-side, no sandbox)`,
    `  write   PUT  ${base}/file       -d '{"workspaceId":"${ws}","path":"<p>","content":"..."}'`,
    `  edit    POST ${base}/file/edit  -d '{"workspaceId":"${ws}","path":"<p>","edits":[{"old_string":"a","new_string":"b"}]}'`,
    `  del/mv  DELETE ${base}/file -d '{"workspaceId":"${ws}","path":"<p>"}'  ·  PATCH same URL -d '{"workspaceId":"${ws}","sourcePath":"<a>","targetPath":"<b>"}'`,
    `  run     POST ${base}/exec       -d '{"workspaceId":"${ws}","command":"<cmd>","timeoutSeconds":30}'`,
    `  comment POST ${base}/comments   -d '{"workspaceId":"${ws}","path":"<p>","quote":"<exact doc text>","body":"<text>"}'`,
    `  alive   POST ${base}/presence   -d '{"workspaceId":"${ws}"}'   (optional: any call above keeps your chip live ~10min)`,
    `  ${suggestLine}`,
    '',
    'Keep edits SMALL and surgical: anchor `old_string` on a short unique snippet and keep',
    '`new_string` minimal — prefer ADDING a line (append after an existing one) over rewriting',
    'existing text, so each suggestion is one clean change, not a block of deletes + re-adds.',
    'ALWAYS batch multiple edits to one file into a SINGLE /file/edit call (the `edits` array',
    'takes many) — never fire one request per edit; separate calls are far slower.',
    'Never write em dashes (—) in prose you add to a document or a comment. Use a comma, a colon,',
    'parentheses, or a new sentence instead.',
    '',
    'After you edit, WATCH for my review feedback — this long-polls (~55s, no repeated polling)',
    'and returns my new comments AND my accept/reject decisions on your suggestions',
    '(type "suggestion", keyed by the suggestionId your write returned):',
    `  export TOKEN="${token}" && curl -sS "${base}/events?workspaceId=${ws}&since=$(date -u +%Y-%m-%dT%H:%M:%SZ)" -H "Authorization: Bearer $TOKEN" -H "X-Agent-Id: ai:<name>"`,
    'If your harness supports background tasks (Claude Code: run_in_background), run that curl as a',
    'BACKGROUND task and END YOUR TURN — I can keep chatting, and you get woken with its output when',
    'a comment lands. If not, make the single blocking call as before. Either way: do what the',
    'comment asks (you may web-search to back a claim), reply via POST /comments/<threadId>/messages,',
    'revise the file, then restart the watch with the returned "cursor" as the next since and end your turn.',
    '',
    `Full contract (large/binary uploads, comment replies/resolve, live in-doc cursor, scoping): ${appUrl}/agent-docs`,
    `Reconnect later without this paste: ${appUrl}/.well-known/agent.json`,
  ].join('\n');
}

export function buildLocalAgentJoinPrompt({
  appUrl,
  token,
  projectUuid,
  editMode,
}: LocalAgentPromptInput): { prompt: string; shortPrompt: string } {
  // ACTIVE path: the full contract inline. It's a one-call connect (the agent
  // curls GET /files directly), the lowest-latency join — no extra round-trip to
  // fetch instructions first. Both `prompt` AND `shortPrompt` carry it: the
  // onboarding step and the workspace connect modal copy `shortPrompt ?? prompt`,
  // so a bare workspace-URL shortPrompt (the old value) left those users pasting a
  // URL with no curl/headers/UUID — a fresh agent couldn't connect or run /events.
  const contract = buildLocalAgentInstructions({ appUrl, token, projectUuid, editMode });

  // SHORTER-paste alternative (kept wired via the /instructions route so it's a
  // one-line switch): point shortPrompt at the contract instead of inlining it —
  // tiny chat window at the cost of one extra round-trip —
  //   const instructionsUrl = `${appUrl}/api/workspace/local-agent/instructions?workspaceId=${projectUuid}&token=${token}&editMode=${editMode}`;
  //   const shortPrompt = [
  //     'Join my Sundial workspace — a live collaborative editor. Fetch your connect + usage guide',
  //     'and follow it, then reply "Connected in Sundial and ready":',
  //     '',
  //     `  curl -sS "${instructionsUrl}"`,
  //     '',
  //     'That URL carries your access token — treat it as a secret.',
  //   ].join('\n');

  return { prompt: contract, shortPrompt: contract };
}
