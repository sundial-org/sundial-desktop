// Local Sunny's tools — executed on the user's machine against the project
// folder. Write/Edit flow through the DocHost (attributed 'agent' in the
// ledger, applied live to any open editor); Bash runs real commands like a
// local coding agent. Descriptions are the same verbatim Anthropic copies the
// cloud brain uses (agent-ts/src/tools/descriptions.ts, imported directly —
// Node's type stripping runs the .ts module as-is; requires Node ≥ 23).
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  BASH_DESCRIPTION,
  EDIT_DESCRIPTION,
  GLOB_DESCRIPTION,
  GREP_DESCRIPTION,
  READ_DESCRIPTION,
  WRITE_DESCRIPTION,
} from '../../agent-ts/src/tools/descriptions.ts';
import { globToRegExp } from '../../lib/workspace/glob-match.ts';
import { readTextFile, writeTextFileAtomic } from '../disk.mjs';
import { fileKind, isIgnoredPath, normalizeRelPath } from '../paths.mjs';
import { locateRel, projectRoots, virtualPath, walkAllRoots } from '../roots.mjs';

const MAX_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_TOOL_OUTPUT = 30_000;
const BASH_TIMEOUT_SECONDS = 120;
const WALK_CACHE_MS = 2_000;

let bashHoldSeq = 0; // per-invocation attribution-window keys

const err = (message) => ({ isError: true, content: message });
const ok = (content) => ({ isError: false, content });

function normalizeToolPath(roots, raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let value = raw.trim();
  // Accept absolute paths inside ANY project root (agents often echo them) —
  // under either spelling of each root: the Claude engine's CLI reports the
  // REALPATH'd cwd (macOS /var → /private/var), so the model echoes that form
  // even when the project was registered via the symlink. Extra-root hits map
  // to their prefixed virtual path.
  if (path.isAbsolute(value)) {
    for (const entry of roots) {
      const forms = new Set([path.resolve(entry.root)]);
      try {
        forms.add(fs.realpathSync(entry.root));
      } catch { /* root vanished — the per-root check below fails cleanly */ }
      const rootAbs = [...forms].find((root) => value === root || value.startsWith(`${root}${path.sep}`));
      if (!rootAbs) continue;
      value = virtualPath(entry.prefix, path.relative(rootAbs, value));
      break;
    }
    if (path.isAbsolute(value)) return null;
  }
  const rel = normalizeRelPath(value);
  if (!rel || isIgnoredPath(rel)) return null;
  return rel;
}

const clip = (text) =>
  text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n… (output clipped)` : text;

/** Tool set bound to one project. `writeText` routes through the sidecar's
 *  attributed write path (DocHost) so agent edits behave like every other
 *  writer: live in open editors, one ledger row, actor 'agent'. `bashEnv`
 *  replaces process.env for Bash children (the Claude engine's sanitized env).
 *  @param {{ project: any, docHost: any, writeText: any, onBashWindow?: ((until: number, holdId?: string) => void) | null, bashEnv?: Record<string, string | undefined> | null }} options */
export function createLocalTools({ project, docHost, writeText, onBashWindow = null, bashEnv = null }) {
  // Re-read per call: extra roots can mount/unmount mid-run.
  const roots = () => projectRoots(docHost.store, project);
  const readCurrentText = async (rel) => {
    const live = docHost.getLiveText(project.id, rel);
    if (live !== null) return live;
    const loc = locateRel(roots(), rel);
    const disk = await readTextFile(loc.root, loc.rel).catch(() => null);
    return disk?.text ?? null;
  };

  // Glob/Grep fan out within a turn; a full recursive walk per call would
  // multiply stats by every tool call. A short TTL keeps results fresh across
  // the agent's own writes without re-walking per call.
  let walkCache = null; // { at, files }
  const walk = async () => {
    if (walkCache && Date.now() - walkCache.at < WALK_CACHE_MS) return walkCache.files;
    const files = await walkAllRoots(roots());
    walkCache = { at: Date.now(), files };
    return files;
  };

  const tools = {
    Read: {
      description: READ_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The path to the file to read' },
          offset: { type: 'number', description: 'The line number to start reading from' },
          limit: { type: 'number', description: 'The number of lines to read' },
        },
        required: ['file_path'],
      },
      async execute(input) {
        const rel = normalizeToolPath(roots(), input.file_path);
        if (!rel) return err('Invalid or ignored path');
        if (fileKind(rel) !== 'text') return err('Only text files can be read locally for now');
        const text = await readCurrentText(rel);
        if (text === null) return err(`File does not exist: ${rel}`);
        const lines = text.split('\n');
        const offset = Math.max(1, Math.floor(input.offset ?? 1));
        const limit = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(input.limit ?? MAX_READ_LINES)));
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const body = slice
          .map((line, index) => `${String(offset + index).padStart(6)}\t${line.slice(0, MAX_LINE_CHARS)}`)
          .join('\n');
        return ok(clip(body || '(empty file)'));
      },
    },

    Write: {
      description: WRITE_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The path to the file to write' },
          content: { type: 'string', description: 'The content to write to the file' },
        },
        required: ['file_path', 'content'],
      },
      async execute(input) {
        const rel = normalizeToolPath(roots(), input.file_path);
        if (!rel) return err('Invalid or ignored path');
        if (fileKind(rel) !== 'text') return err('Only text files can be written locally for now');
        await writeText(rel, String(input.content ?? ''));
        return ok(`Wrote ${rel}`);
      },
    },

    Edit: {
      description: EDIT_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The path to the file to modify' },
          old_string: { type: 'string', description: 'The text to replace' },
          new_string: { type: 'string', description: 'The text to replace it with' },
          replace_all: { type: 'boolean', description: 'Replace all occurences of old_string (default false)' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
      async execute(input) {
        const rel = normalizeToolPath(roots(), input.file_path);
        if (!rel) return err('Invalid or ignored path');
        // Same guard as Read/Write: decoding a binary as UTF-8 and writing
        // it back as text would corrupt the file on disk.
        if (fileKind(rel) !== 'text') return err('Only text files can be edited locally for now');
        const text = await readCurrentText(rel);
        if (text === null) return err(`File does not exist: ${rel}`);
        const oldString = String(input.old_string ?? '');
        const newString = String(input.new_string ?? '');
        if (!oldString) return err('old_string must not be empty');
        if (!text.includes(oldString)) return err('old_string not found in file');
        if (!input.replace_all && text.indexOf(oldString) !== text.lastIndexOf(oldString)) {
          return err('old_string is not unique in the file; provide more context or set replace_all');
        }
        // Replacement callback: a bare string would interpret $-patterns
        // ($$, $&, $`) and silently corrupt e.g. Makefile `$$VAR` edits.
        const next = input.replace_all
          ? text.split(oldString).join(newString)
          : text.replace(oldString, () => newString);
        await writeText(rel, next);
        return ok(`Edited ${rel}`);
      },
    },

    Glob: {
      description: GLOB_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The glob pattern to match files against' },
          path: { type: 'string', description: 'The directory to search in (defaults to the project root)' },
        },
        required: ['pattern'],
      },
      async execute(input) {
        const prefixRel = input.path ? normalizeToolPath(roots(), input.path) : '';
        if (input.path && prefixRel === null) return err('Invalid or ignored path');
        const matcher = globToRegExp(String(input.pattern ?? ''));
        const files = (await walk())
          .filter((file) => file.type !== 'folder')
          .map((file) => file.path)
          .filter((rel) => (!prefixRel || rel === prefixRel || rel.startsWith(`${prefixRel}/`)))
          .filter((rel) => matcher.test(prefixRel ? rel.slice(prefixRel.length + 1) : rel) || matcher.test(rel));
        return ok(clip(files.length ? files.join('\n') : 'No files found'));
      },
    },

    Grep: {
      description: GREP_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The regular expression pattern to search for in file contents' },
          path: { type: 'string', description: 'File or directory to search in (defaults to the project root)' },
          '-i': { type: 'boolean', description: 'Case insensitive search' },
        },
        required: ['pattern'],
      },
      async execute(input) {
        const prefixRel = input.path ? normalizeToolPath(roots(), input.path) : '';
        if (input.path && prefixRel === null) return err('Invalid or ignored path');
        let matcher;
        try {
          matcher = new RegExp(String(input.pattern ?? ''), input['-i'] === true ? 'i' : '');
        } catch {
          return err('Invalid regular expression');
        }
        const out = [];
        for (const file of await walk()) {
          if (file.type !== 'text') continue;
          if (prefixRel && file.path !== prefixRel && !file.path.startsWith(`${prefixRel}/`)) continue;
          const text = await readCurrentText(file.path);
          if (text === null) continue;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i += 1) {
            if (matcher.test(lines[i])) out.push(`${file.path}:${i + 1}:${lines[i].slice(0, 300)}`);
            if (out.length >= 200) return ok(clip(out.join('\n')));
          }
        }
        return ok(clip(out.length ? out.join('\n') : 'No matches found'));
      },
    },

    Bash: {
      description: BASH_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute' },
          // SECONDS — must match the verbatim description ('timeout in
          // seconds (max 600 / 10 minutes)'), which is what the model reads.
          timeout: { type: 'number', description: 'Optional timeout in seconds (max 600)' },
          description: {
            type: 'string',
            description: 'Clear, concise description of what this command does in 5-10 words',
          },
        },
        required: ['command'],
      },
      async execute(input) {
        const command = String(input.command ?? '').trim();
        if (!command) return err('command is required');
        const timeout = Math.min(600, Math.max(1, Math.floor(input.timeout ?? BASH_TIMEOUT_SECONDS))) * 1000;
        // The sidecar's bearer token grants access to EVERY local project —
        // never let child processes (and thus the model transcript) see it.
        const { SUNDIAL_LOCAL_TOKEN, ...env } = bashEnv ?? process.env;
        // Bash writes reach the ledger via the WATCHER, not the agent writer
        // — open an attribution window (command lifetime, then a short grace
        // for the debounced events) so those rows say agent/chat, not
        // 'external'. Per-invocation key: overlapping calls hold windows
        // independently, so one finishing never shortens another's.
        const holdId = `b${++bashHoldSeq}`;
        onBashWindow?.(Date.now() + timeout + 2_000, holdId);
        return new Promise((resolve) => {
          exec(
            command,
            { cwd: project.root, timeout, maxBuffer: 4 * 1024 * 1024, env },
            (error, stdout, stderr) => {
              onBashWindow?.(Date.now() + 2_000, holdId);
              const output = clip([stdout, stderr].filter(Boolean).join('\n').trim());
              if (error) {
                resolve(err(output || error.message));
                return;
              }
              resolve(ok(output || '(no output)'));
            },
          );
        });
      },
    },
  };

  return tools;
}

export function toolDefinitions(tools) {
  return Object.entries(tools).map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: def.inputSchema,
  }));
}

/** Ledger author id for a chat's engine — which agent actually wrote
 *  (the fine-tuning corpus must tell claude-code from codex from cloud-step). */
export function engineAuthorId(harness) {
  if (harness === 'claude') return 'ai:claude-code';
  if (harness === 'openai') return 'ai:codex';
  return 'ai:sunny-local';
}

/** Verified write used by Write/Edit: atomic disk write + DocHost fold-in with
 *  'agent' attribution + bridge/SSE propagation — the same rail as the
 *  sidecar's PUT /file. In suggest mode the content stages as a pending
 *  suggestion (marks / code ledger) instead of applying directly. Kept here so
 *  the runner needs only project wiring. */
export function createAgentWriter({ project, docHost, watchers, bridges, emit, chatId = null, authorId = null, editMode = 'edit' }) {
  return async (rel, content) => {
    // Suggest mode stages a pending suggestion. Staging can DECLINE a real
    // change it cannot represent as marks (e.g. a spacing-only markdown edit)
    // — fall through to the direct rail then, so a reported-successful write
    // is never silently dropped.
    const staged =
      editMode === 'suggest' &&
      (await docHost.stageAgentSuggestion(project.id, rel, content, { chatId, authorId }));
    if (!staged) {
      watchers.get(project.id)?.suppress(rel);
      const loc = locateRel(projectRoots(docHost.store, project), rel);
      await writeTextFileAtomic(loc.root, loc.rel, content);
      await docHost.handleDiskChange(project.id, rel, { actor: 'agent', chatId, authorId });
    }
    await bridges.handleLocalFileEvent(project.id, rel);
    emit(project.id, { type: 'files-changed', path: rel });
  };
}
