// External agent sessions: Claude Code (~/.claude/projects/<encoded-cwd>/*.jsonl)
// and Codex (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) transcripts whose cwd
// sits inside a project root. STRICTLY READ-ONLY — this module (and everything
// downstream of it) must never write inside another agent's home directory.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Scan budgets: these directories belong to the user's whole machine, not this
// project — a long-lived install can hold thousands of transcripts.
const CLAUDE_SESSION_CAP = 40; // verified matches per listing
const CLAUDE_FILE_SCAN_CAP = 400; // candidate heads read per listing (newest first)
const CODEX_FILE_SCAN_CAP = 400; // rollout heads read per listing (newest first)
const CODEX_MATCH_CAP = 40;
const HEAD_BYTES = 64 * 1024;
const IMPORT_ROW_CAP = 2000; // keep the transcript tail, like the chat window
const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024; // never materialize a huge transcript whole

export const claudeProjectsDir = () =>
  path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
export const codexSessionsDir = () =>
  path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');

/** Claude Code's project-dir encoding is lossy (every non-alphanumeric → '-'),
 *  so directory names only PRE-FILTER candidates; each session's real cwd is
 *  verified from its transcript/index before it's listed. */
const encodeClaudeDir = (dir) => dir.replace(/[^a-zA-Z0-9]/g, '-');

const underRoots = (cwd, roots) =>
  typeof cwd === 'string' &&
  roots.some((entry) => cwd === entry.root || cwd.startsWith(`${entry.root}${path.sep}`));

/** Claude Code harness plumbing injected as user content — never something
 *  the user typed. A real prompt may legitimately start with '<' (XML/JSX),
 *  so only these known wrappers are dropped. */
const CLAUDE_META_CONTENT =
  /^<(system-reminder|system_warning|command-name|command-message|command-args|command-stdout|command-stderr|local-command|bash-input|bash-stdout|bash-stderr|user-memory-input|task-notification)\b/;
const isClaudeUserText = (line, text) =>
  typeof text === 'string' && text.length > 0 && !line.isMeta && !CLAUDE_META_CONTENT.test(text);

const truncate = (text, max = 120) => {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean || null;
};

async function readHead(file, bytes = HEAD_BYTES) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Last `bytes` of a file, aligned to a line start when reading mid-file —
 *  agent transcripts can carry huge tool outputs, and only the tail renders. */
async function readTailLines(file, bytes = TRANSCRIPT_TAIL_BYTES) {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await handle.close();
  }
}

function parseLines(text) {
  const lines = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw));
    } catch {
      /* truncated tail / non-JSON noise */
    }
  }
  return lines;
}

/** Session head metadata for one Claude jsonl: real cwd, first prompt, and
 *  whether the file is a sidechain (subagent) transcript. */
function claudeHeadMeta(lines) {
  let cwd = null;
  let firstPrompt = null;
  let sidechain = false;
  for (const line of lines) {
    if (!cwd && typeof line.cwd === 'string') cwd = line.cwd;
    if (line.type !== 'user') continue;
    if (line.isSidechain === true) sidechain = true;
    const content = line.message?.content;
    if (!firstPrompt && typeof content === 'string' && isClaudeUserText(line, content)) {
      firstPrompt = content;
    }
    if (cwd && (firstPrompt || sidechain)) break;
  }
  return { cwd, firstPrompt, sidechain };
}

async function listClaudeSessions(roots, exclude = new Set()) {
  const projectsDir = claudeProjectsDir();
  const dirs = await fsp.readdir(projectsDir).catch(() => []);
  const encoded = roots.map((entry) => encodeClaudeDir(entry.root));
  const candidates = [];
  for (const dir of dirs) {
    if (!encoded.some((enc) => dir === enc || dir.startsWith(`${enc}-`))) continue;
    const dirPath = path.join(projectsDir, dir);
    for (const name of await fsp.readdir(dirPath).catch(() => [])) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dirPath, name);
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat?.isFile()) continue;
      candidates.push({
        file,
        dirPath,
        id: name.slice(0, -'.jsonl'.length),
        mtimeMs: stat.mtimeMs,
        birthtimeMs: stat.birthtimeMs,
      });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Claude's own sessions-index.json (when fresh for a file) saves parsing the
  // transcript head; entries carry the real cwd, summary, and sidechain flag.
  const indexByDir = new Map();
  const indexFor = async (dirPath) => {
    if (!indexByDir.has(dirPath)) {
      const parsed = await fsp
        .readFile(path.join(dirPath, 'sessions-index.json'), 'utf8')
        .then((text) => JSON.parse(text))
        .catch(() => null);
      const entries = new Map();
      for (const entry of parsed?.entries ?? []) {
        if (typeof entry?.sessionId === 'string') entries.set(entry.sessionId, entry);
      }
      indexByDir.set(dirPath, entries);
    }
    return indexByDir.get(dirPath);
  };

  // Cap on VERIFIED matches (with a separate parse budget), not raw
  // candidates: a burst of newer sidechain/prefix-collision files must not
  // starve real sessions out of the window.
  const sessions = [];
  let parsed = 0;
  for (const candidate of candidates) {
    if (sessions.length >= CLAUDE_SESSION_CAP || parsed >= CLAUDE_FILE_SCAN_CAP) break;
    // Adopted sessions must not consume the caps — a heavily-imported project
    // would otherwise list nothing while older unadopted sessions exist.
    if (exclude.has(`claude:${candidate.id}`)) continue;
    parsed += 1;
    const entry = (await indexFor(candidate.dirPath)).get(candidate.id);
    let meta;
    if (entry && entry.fileMtime >= candidate.mtimeMs && typeof entry.projectPath === 'string') {
      meta = {
        cwd: entry.projectPath,
        firstPrompt: entry.summary || entry.firstPrompt,
        sidechain: entry.isSidechain === true,
      };
    } else {
      meta = claudeHeadMeta(parseLines(await readHead(candidate.file).catch(() => '')));
    }
    if (meta.sidechain || !underRoots(meta.cwd, roots)) continue;
    sessions.push({
      id: candidate.id,
      agent: 'claude',
      title: truncate(meta.firstPrompt),
      cwd: meta.cwd,
      path: candidate.file,
      created_at: new Date(candidate.birthtimeMs || candidate.mtimeMs).toISOString(),
      updated_at: new Date(candidate.mtimeMs).toISOString(),
    });
  }
  return sessions;
}

const numericDesc = async (dir) =>
  (await fsp.readdir(dir).catch(() => [])).filter((name) => /^\d+$/.test(name)).sort().reverse();

/** Walk the sessions tree newest-day-first, yielding [dayDir, files-desc]. */
async function* codexDayDirs() {
  const base = codexSessionsDir();
  for (const year of await numericDesc(base)) {
    for (const month of await numericDesc(path.join(base, year))) {
      for (const day of await numericDesc(path.join(base, year, month))) {
        const dayDir = path.join(base, year, month, day);
        const files = (await fsp.readdir(dayDir).catch(() => []))
          .filter((name) => name.endsWith('.jsonl'))
          .sort()
          .reverse();
        yield [dayDir, files];
      }
    }
  }
}

/** Cheap existence probe for a Codex rollout by session id — the id is baked
 *  into the filename, so this is readdir-only (no head reads, no budget). */
export async function codexSessionFileExists(id) {
  if (!id) return false;
  for await (const [, files] of codexDayDirs()) {
    if (files.some((name) => name.includes(id))) return true;
  }
  return false;
}

async function listCodexSessions(roots, exclude = new Set()) {
  const sessions = [];
  let scanned = 0;
  for await (const [dayDir, files] of codexDayDirs()) {
    for (const name of files) {
      if (scanned >= CODEX_FILE_SCAN_CAP || sessions.length >= CODEX_MATCH_CAP) return sessions;
      scanned += 1;
      const file = path.join(dayDir, name);
      const lines = parseLines(await readHead(file).catch(() => ''));
      const meta = lines.find((line) => line.type === 'session_meta')?.payload;
      if (!meta?.id || !underRoots(meta.cwd, roots)) continue;
      // Adopted sessions consume scan budget (the id lives inside the file)
      // but never the match cap — see the Claude twin above.
      if (exclude.has(`codex:${meta.id}`)) continue;
      // Worker rollouts (source: {subagent: …}) are internal transcripts,
      // the Codex twin of Claude sidechains — never user-facing chats.
      if (meta.source && typeof meta.source === 'object' && 'subagent' in meta.source) continue;
      const firstPrompt = lines.find(
        (line) => line.type === 'event_msg' && line.payload?.type === 'user_message',
      )?.payload?.message;
      const stat = await fsp.stat(file).catch(() => null);
      sessions.push({
        id: meta.id,
        agent: 'codex',
        title: truncate(firstPrompt),
        cwd: meta.cwd,
        path: file,
        created_at: typeof meta.timestamp === 'string' ? meta.timestamp : null,
        updated_at: stat ? new Date(stat.mtimeMs).toISOString() : null,
      });
    }
  }
  return sessions;
}

/** All external sessions under the project's roots, newest first. `exclude` is
 *  a Set of `${agent}:${sessionId}` already adopted as local chats (an adopted
 *  session lives on as a real chat row — listing it again would duplicate it). */
export async function listExternalSessions({ roots, exclude = new Set() }) {
  const [claude, codex] = await Promise.all([
    listClaudeSessions(roots, exclude),
    listCodexSessions(roots, exclude),
  ]);
  return [...claude, ...codex].sort((a, b) =>
    String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')),
  );
}

/** Cheap existence probe for a Claude session file given its recorded cwd —
 *  the session dir IS the encoded cwd, so no scan (or scan budget) applies. */
export function claudeSessionFileExists(cwd, id) {
  return fs.existsSync(path.join(claudeProjectsDir(), encodeClaudeDir(cwd), `${id}.jsonl`));
}

/** Re-locate one session by id — endpoints never trust client-sent paths. */
export async function findExternalSession({ roots, agent, id }) {
  const sessions = agent === 'codex' ? await listCodexSessions(roots) : await listClaudeSessions(roots);
  return sessions.find((session) => session.id === id) ?? null;
}

const toolResultText = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block) => (block?.type === 'text' ? block.text ?? '' : '')).join('');
  }
  return '';
};

/** Claude Code transcript lines → sidecar chat rows ({role, content, metadata,
 *  created_at} — the exact shape local_messages/rowsToUIMessages speak). */
export function parseClaudeTranscript(lines) {
  const rows = [];
  const toolNameById = new Map();
  const push = (line, row) => rows.push({ ...row, created_at: line.timestamp ?? null });
  for (const line of lines) {
    if (line.isSidechain === true) continue;
    const content = line.message?.content;
    if (line.type === 'user') {
      if (typeof content === 'string') {
        if (isClaudeUserText(line, content)) push(line, { role: 'user', content });
        continue;
      }
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === 'tool_result') {
          push(line, {
            role: 'system',
            content: toolResultText(block.content),
            metadata: {
              type: 'tool_result',
              tool_use_id: block.tool_use_id,
              tool_name: toolNameById.get(block.tool_use_id) ?? 'tool',
              is_error: block.is_error === true,
            },
          });
        } else if (block?.type === 'text' && isClaudeUserText(line, block.text)) {
          push(line, { role: 'user', content: block.text });
        }
      }
    } else if (line.type === 'assistant') {
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === 'text' && block.text?.trim()) {
          push(line, { role: 'assistant', content: block.text, metadata: {} });
        } else if (block?.type === 'thinking' && block.thinking?.trim()) {
          push(line, { role: 'system', content: block.thinking, metadata: { type: 'thinking' } });
        } else if (block?.type === 'tool_use') {
          toolNameById.set(block.id, block.name);
          push(line, {
            role: 'system',
            content: '',
            metadata: { type: 'tool_use', tool_use_id: block.id, tool: { name: block.name, input: block.input ?? {} } },
          });
        }
      }
    }
  }
  return rows;
}

/** Codex rollout lines → sidecar chat rows. User/assistant text comes from the
 *  event_msg stream (the response_item copies also carry harness plumbing like
 *  AGENTS.md/environment context); tools from the response_item stream. */
export function parseCodexTranscript(lines) {
  const rows = [];
  for (const line of lines) {
    const payload = line.payload;
    if (!payload) continue;
    const push = (row) => rows.push({ ...row, created_at: line.timestamp ?? null });
    if (line.type === 'event_msg') {
      if (payload.type === 'user_message' && typeof payload.message === 'string' && payload.message.trim()) {
        // Rollouts can repeat a turn's user event (e.g. around reconnects) —
        // adjacent identical copies collapse to one row.
        const last = rows[rows.length - 1];
        if (!(last?.role === 'user' && last.content === payload.message)) {
          push({ role: 'user', content: payload.message });
        }
      } else if (payload.type === 'agent_message' && typeof payload.message === 'string' && payload.message.trim()) {
        push({ role: 'assistant', content: payload.message, metadata: {} });
      }
    } else if (line.type === 'response_item' && payload.type === 'function_call') {
      let input;
      try {
        input = JSON.parse(payload.arguments);
      } catch {
        input = { arguments: payload.arguments ?? '' };
      }
      push({
        role: 'system',
        content: '',
        metadata: { type: 'tool_use', tool_use_id: payload.call_id, tool: { name: payload.name ?? 'tool', input } },
      });
    } else if (line.type === 'response_item' && payload.type === 'function_call_output') {
      push({
        role: 'system',
        content: typeof payload.output === 'string' ? payload.output : toolResultText(payload.output?.content),
        metadata: { type: 'tool_result', tool_use_id: payload.call_id, tool_name: 'tool', is_error: false },
      });
    }
  }
  return rows;
}

/** Transcript tail of a located session as sequenced chat-message rows. */
export async function readExternalSessionMessages(session) {
  const lines = parseLines(await readTailLines(session.path));
  const rows = session.agent === 'codex' ? parseCodexTranscript(lines) : parseClaudeTranscript(lines);
  return rows.slice(-IMPORT_ROW_CAP).map((row, index) => ({
    id: `${session.id}:${index}`,
    chat_id: null,
    role: row.role,
    content: row.content ?? '',
    metadata: row.metadata ?? null,
    client_id: null,
    sequence: index + 1,
    created_at: row.created_at,
  }));
}
