// Local Sunny's tools — executed on the user's machine against the project
// folder. Write/Edit flow through the DocHost (attributed 'agent' in the
// ledger, applied live to any open editor); Bash runs real commands like a
// local coding agent. Descriptions are the same verbatim Anthropic copies the
// cloud brain uses (agent-ts/src/tools/descriptions.ts, imported directly —
// Node's type stripping runs the .ts module as-is; requires Node ≥ 23).
import { spawn } from 'node:child_process';
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
import { MAX_TEXT_BYTES, readTextFile, safeResolveInRoot, writeTextFileAtomic } from '../disk.mjs';
import { fileKind, fileKindForFile, isIgnoredPath, mimeFor, normalizeRelPath } from '../paths.mjs';
import { locateRel, projectRoots, virtualPath, walkAllRoots } from '../roots.mjs';

const MAX_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_TOOL_OUTPUT = 30_000;
const BASH_TIMEOUT_SECONDS = 120;
const MAX_BASH_BUFFER = 4 * 1024 * 1024;
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

// Raster formats every vision model reads. Same set as the cloud side keeps in
// agent-ts/src/session/history.ts and agent-ts/src/tools/read.ts — kept local
// rather than imported because those modules pull the gateway in.
const VIEWABLE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// Deliberately NOT the cloud's limit, and not unified with it: the cloud reads
// blobs inside the brain and is bounded by Anthropic's 5 MB per image, while a
// LOCAL read has to survive the trip through /api/agent/local-step, a Vercel
// function with a ~4.5 MB request body cap. Base64 inflates bytes by 4/3, so
// 2.5 MB encodes to ~3.4 MB and still leaves room for the conversation and the
// tool definitions. Two different constraints, two different numbers.
const MAX_IMAGE_BYTES = 2_500_000;

/** Does this decoded text look like it was never text? A NUL byte is the
 *  classic tell; a scattering of U+FFFD means the decoder was guessing. Both
 *  are sampled from the head, so a huge file costs nothing to classify. */
function looksBinary(text) {
  const sample = text.slice(0, 8192);
  if (sample.includes('\u0000')) return true;
  const replacements = (sample.match(/\uFFFD/g) ?? []).length;
  // Small absolute floor as well as the ratio: it only has to excuse the one
  // or two legitimate U+FFFD a real document might contain, since a single one
  // in a very short file clears 1% by itself. Anything higher protects the
  // wrong side — a 40-character file with 8 replacement chars is mojibake, and
  // serving it as text is the failure this whole check exists to stop.
  return replacements > 2 && replacements / Math.max(sample.length, 1) > 0.01;
}

/** Why a text read came back empty-handed. "File does not exist" was reported
 *  for BOTH a missing path and one over the 10 MB text-read cap, which sent
 *  the model hunting for a file that is sitting right there. */
async function unreadableReason(roots, rel) {
  const loc = locateRel(roots, rel);
  const abs = await safeResolveInRoot(loc.root, loc.rel).catch(() => null);
  const size = abs === null ? null : await fs.promises.stat(abs).then((s) => (s.isFile() ? s.size : null), () => null);
  if (size === null) return `File does not exist: ${rel}`;
  if (size > MAX_TEXT_BYTES) {
    return (
      `${rel} is ${size} B, over the ${MAX_TEXT_BYTES} byte limit for a text read. ` +
      'Read the part you need with Bash instead (sed -n, head, grep).'
    );
  }
  return `Could not read ${rel}`;
}

/** Read of a NON-text file. A viewable image comes back as bytes the model
 *  actually looks at (the runner ships `image` as a content-array tool
 *  output); anything else gets an honest, actionable error naming the file,
 *  its type and its size — the old vague refusal just made the model retry the
 *  same Read in a loop. Bash is a real suggestion here, unlike in the cloud
 *  sandbox: this is the user's own machine, so it may well have the tool. */
async function readBinary(roots, rel) {
  const loc = locateRel(roots, rel);
  const abs = await safeResolveInRoot(loc.root, loc.rel).catch(() => null);
  const size = abs === null ? null : await fs.promises.stat(abs).then((s) => (s.isFile() ? s.size : null), () => null);
  if (size === null) return err(`File does not exist: ${rel}`);
  const mime = mimeFor(rel);
  const label = `${rel} (${mime ?? 'unknown type'}, ${size} B)`;
  // A truncated download or `touch`ed placeholder: encoding it would ship an
  // empty base64 payload the provider rejects, failing the whole step with an
  // opaque error instead of a readable tool result.
  if (size === 0) return err(`${label} is empty, so there is nothing to read.`);
  if (!VIEWABLE_IMAGE_MIMES.has(mime)) {
    return err(
      `${label} is not text and cannot be attached to this conversation. Tell the user instead of reading it again. ` +
        'If a command-line tool on this machine can extract what you need (pdftotext, ImageMagick, ffprobe), try it with Bash.',
    );
  }
  if (size > MAX_IMAGE_BYTES) {
    return err(
      `${label} is over the ${MAX_IMAGE_BYTES} byte limit for an attached image. Tell the user instead of reading it again. ` +
        'If this machine has ImageMagick, downscale a copy with Bash and read that.',
    );
  }
  const data = await fs.promises.readFile(abs).catch(() => null);
  if (!data) return err(`Could not read ${rel}`);
  // The bytes live only in THIS turn's model context — the stored row keeps
  // the label alone. Say so, or a later turn replays a Read that "succeeded"
  // and returned nothing but a filename, and the model answers from nothing
  // instead of looking again.
  return {
    isError: false,
    content: `${label}. The image is attached to this message. Read it again to see it in a later turn.`,
    image: { data: data.toString('base64'), mediaType: mime },
  };
}

// Comment author for agent-written threads/replies — same shape the cloud
// stamps (agent-ts authorColumns). The `agent:` prefix is also what keeps a
// Sunny comment from re-triggering the comment→chat rail.
// `name` is the DISPLAY name; `username`/`userId` are the self-filter markers
// the delivery gate reads (a human check on username 'sunny' + the `agent:`
// prefix), so only the display name changes here — touching the others would
// make the agent's own replies re-trigger runs.
export const SUNNY_AUTHOR = { userId: 'agent:sunny', name: 'Agent', username: 'sunny', imageUrl: '/sunnies/sundial-default.webp' };
const MAX_QUOTE_LENGTH = 180; // lib/workspace/doc-comments.clipCommentQuote
const clipQuote = (text) => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= MAX_QUOTE_LENGTH ? normalized : `${normalized.slice(0, MAX_QUOTE_LENGTH - 1).trimEnd()}…`;
};

/** Tool set bound to one project. `writeText` routes through the sidecar's
 *  attributed write path (DocHost) so agent edits behave like every other
 *  writer: live in open editors, one ledger row, actor 'agent'. `bashEnv`
 *  replaces process.env for Bash children (the Claude engine's sanitized env).
 *  `signal` is the RUN's abort signal: Stop must reach the tools too, or a
 *  queued batch keeps executing and a running Bash child keeps going.
 *  @param {{ project: any, docHost: any, writeText: any, messageId?: string | null, chatId?: string | null, onCommentsChanged?: (() => void) | null, onBashWindow?: ((until: number, holdId?: string) => void) | null, bashEnv?: Record<string, string | undefined> | null, bridges?: any, signal?: AbortSignal | null }} options */
export function createLocalTools({
  project, docHost, writeText, messageId = null, chatId = null, onCommentsChanged = null, onBashWindow = null, bashEnv = null,
  bridges = null, signal = null,
}) {
  const store = docHost.store;
  // Share-covered threads live in the CLOUD store (see server.mjs /comments):
  // the local twin has no row for them, so comment tools fall back to the
  // mirror. Absent bridges (tests) or engine (unshared path) ⇒ local only.
  const cloudThreadList = async (rel) => {
    if (!bridges) return [];
    try {
      return await bridges.listCloudCommentThreads(project.id, rel ?? null);
    } catch {
      return [];
    }
  };
  const cloudThreadById = async (threadId) =>
    (await cloudThreadList(null)).find((thread) => thread.id === threadId) ?? null;
  const cloudMutate = (rel, method, payload) => {
    const engine = bridges?.commentEngineFor?.(project.id, rel);
    if (!engine) throw new Error(`no cloud mirror for ${rel}`);
    return engine.mutateCloudComment(method, payload);
  };
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
      // The shared description is the CLOUD Read's, which hands back only text.
      // This one attaches image bytes, and models otherwise fall back on their
      // prior that they cannot see pictures — one user watched Sunny refuse to
      // look at a screenshot without ever calling Read.
      description: `${READ_DESCRIPTION}- A PNG, JPEG, GIF or WebP under ${MAX_IMAGE_BYTES} bytes comes back as the picture itself, for you to look at. Read it before saying anything about what an image shows, and never claim you cannot see images. Anything larger, or any other binary format, returns an error saying what to try instead.\n`,
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
        // Only a KNOWN binary extension goes down the attachment path.
        // fileKind returns null for anything unrecognised — Dockerfile,
        // Makefile, .gitignore, .vue, .kt, .lock — and those are ordinary text
        // the plain read below handles fine. Treating them as binary told the
        // model to give up on files it could simply have read.
        if (fileKind(rel) === 'blob') return readBinary(roots(), rel);
        const text = await readCurrentText(rel);
        if (text === null) return err(await unreadableReason(roots(), rel));
        // An unrecognised extension can still be BINARY (data.sqlite,
        // libfoo.dylib, model.wasm). UTF-8-decoding those yields thousands of
        // replacement chars, and returning 30k of mojibake as a SUCCESSFUL
        // read is worse than a clear refusal — the model treats it as content.
        if (looksBinary(text)) {
          return err(
            `${rel} is binary data, not text, and its type is not one this agent can attach. ` +
              'Tell the user instead of reading it again. If a command-line tool on this machine can ' +
              'make sense of it, try it with Bash: `file`, `strings`, `sqlite3`, `xxd`, or ' +
              '`iconv -f UTF-16` when it is really text in another encoding.',
          );
        }
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
        if (fileKindForFile(rel) !== 'text') return err('Only text files can be written locally for now');
        await writeText(rel, String(input.content ?? ''), { messageId });
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
        if (fileKindForFile(rel) !== 'text') return err('Only text files can be edited locally for now');
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
        await writeText(rel, next, { messageId });
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

    // ---- Doc comments — the local twin of agent-ts/src/tools/comments.ts.
    // Same names/shapes as the cloud tools (the model sees one contract on
    // either runtime); the store is SQLite instead of Supabase.
    list_comments: {
      description:
        'List the comment threads humans (and other agents) left on this project\'s documents, ' +
        'so you can see and act on their feedback. Optionally pass `path` to scope to one file. ' +
        'Returns each thread\'s id — pass it to reply_comment or resolve_comment — its file, the ' +
        'quoted span, and every message in order. Only open threads are listed unless you set ' +
        '`include_resolved`.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to scope to. Omit to list across the whole project.' },
          include_resolved: { type: 'boolean', description: 'Also include resolved threads (default: only open ones).' },
        },
      },
      async execute(input) {
        const rel = input.path ? normalizeToolPath(roots(), input.path) : null;
        if (input.path && !rel) return err('Invalid or ignored path');
        const threads = [
          ...store.listCommentThreads(project.id, { path: rel }),
          ...(await cloudThreadList(rel)),
        ].filter((thread) => input.include_resolved === true || thread.status === 'open');
        if (threads.length === 0) return ok(rel ? `No comments on ${rel}.` : 'No comments in this project.');
        const out = [];
        for (const thread of threads) {
          out.push(`thread ${thread.id}${thread.status === 'resolved' ? ' [resolved]' : ''} · ${thread.filePath}`);
          out.push(`  quote: "${thread.quote}"`);
          for (const message of thread.messages) out.push(`  ${message.author?.name ?? '?'}: ${message.body}`);
          out.push('');
        }
        return ok(clip(out.join('\n').trimEnd()));
      },
    },

    add_comment: {
      description:
        'Add a comment to a quoted span of text in a project file, on the user\'s behalf. Provide ' +
        'the file `path`, the exact `quote` the comment attaches to (it must appear verbatim in ' +
        'the current file), and the comment `body`. The comment shows up in the document\'s ' +
        'comments panel anchored to that quote, authored as Sunny.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to comment on.' },
          quote: { type: 'string', description: 'Exact text from the file to anchor the comment to.' },
          body: { type: 'string', description: 'The comment text.' },
        },
        required: ['path', 'quote', 'body'],
      },
      async execute(input) {
        const rel = normalizeToolPath(roots(), input.path);
        const quote = String(input.quote ?? '').trim();
        const body = String(input.body ?? '').trim();
        if (!rel) return err('Invalid or ignored path');
        if (!quote || !body) return err('path, quote, and body are all required.');
        const text = await readCurrentText(rel);
        if (text === null) return err(`File does not exist: ${rel}`);
        // An empty file contains no quote either — a detached anchor would
        // render an unusable comment.
        if (!text.includes(quote)) {
          return err(`The quote was not found verbatim in ${rel}. Re-read the file and copy an exact span, then try again.`);
        }
        // Same anchor shape the cloud tool writes — the comments UI resolves
        // it by substring, so it survives edits around the span.
        const anchor = { kind: 'string-quote', quote };
        const engine = bridges?.commentEngineFor?.(project.id, rel);
        if (engine) {
          // Share-covered path: the cloud store is the one both sides read.
          try {
            await engine.mutateCloudComment('POST', {
              filePath: rel, quote: clipQuote(quote), anchor, head: anchor, body, author: SUNNY_AUTHOR,
            });
          } catch (error) {
            return err(`Commenting failed: ${error?.message ?? 'cloud mirror unavailable'}`);
          }
        } else {
          store.createCommentThread(project.id, {
            path: rel, quote: clipQuote(quote), anchor, head: anchor, body, author: SUNNY_AUTHOR,
          });
        }
        onCommentsChanged?.(project.id, rel);
        return ok(`Added a comment on "${clipQuote(quote)}" in ${rel}.`);
      },
    },

    reply_comment: {
      description:
        'Reply to an existing comment thread, authored as Sunny. Get the `thread_id` from ' +
        'list_comments first. Your reply lands in the comments panel and bumps the thread. ' +
        "You can't reply to a resolved thread — reopen it first.",
      inputSchema: {
        type: 'object',
        properties: {
          thread_id: { type: 'string', description: 'The comment thread id (from list_comments).' },
          body: { type: 'string', description: 'The reply text.' },
        },
        required: ['thread_id', 'body'],
      },
      async execute(input) {
        const threadId = String(input.thread_id ?? '').trim();
        const body = String(input.body ?? '').trim();
        if (!body) return err('body is required.');
        const thread = store.getCommentThread(threadId);
        if (thread && thread.projectId === project.id) {
          if (thread.status === 'resolved') {
            return err('This thread is resolved — reopen it with resolve_comment before replying.');
          }
          store.addCommentMessage(thread.id, { body, author: SUNNY_AUTHOR });
          onCommentsChanged?.(project.id, thread.filePath);
          return ok(`Replied to comment thread ${thread.id}.`);
        }
        const cloud = await cloudThreadById(threadId);
        if (!cloud) return err(`Comment thread not found: ${input.thread_id}`);
        if (cloud.status === 'resolved') {
          return err('This thread is resolved — reopen it with resolve_comment before replying.');
        }
        try {
          await cloudMutate(cloud.filePath, 'PATCH', {
            threadId: cloud.id,
            filePath: cloud.filePath,
            action: 'reply',
            body,
            author: SUNNY_AUTHOR,
          });
        } catch (error) {
          return err(`Replying failed: ${error?.message ?? 'cloud mirror unavailable'}`);
        }
        onCommentsChanged?.(project.id, cloud.filePath);
        return ok(`Replied to comment thread ${cloud.id}.`);
      },
    },

    resolve_comment: {
      description:
        "Resolve a comment thread once you've addressed it, or reopen one with `reopen: true`. " +
        'Get the `thread_id` from list_comments.',
      inputSchema: {
        type: 'object',
        properties: {
          thread_id: { type: 'string', description: 'The comment thread id (from list_comments).' },
          reopen: { type: 'boolean', description: 'Reopen the thread instead of resolving it.' },
        },
        required: ['thread_id'],
      },
      async execute(input) {
        const threadId = String(input.thread_id ?? '').trim();
        const reopen = input.reopen === true;
        const thread = store.getCommentThread(threadId);
        if (thread && thread.projectId === project.id) {
          store.setCommentThreadStatus(thread.id, reopen ? 'open' : 'resolved', reopen ? null : SUNNY_AUTHOR.userId);
          onCommentsChanged?.(project.id, thread.filePath);
          return ok(reopen ? `Reopened comment thread ${thread.id}.` : `Resolved comment thread ${thread.id}.`);
        }
        const cloud = await cloudThreadById(threadId);
        if (!cloud) return err(`Comment thread not found: ${input.thread_id}`);
        try {
          await cloudMutate(cloud.filePath, 'PATCH', {
            threadId: cloud.id,
            filePath: cloud.filePath,
            action: reopen ? 'reopen' : 'resolve',
            author: SUNNY_AUTHOR,
          });
        } catch (error) {
          return err(`Updating failed: ${error?.message ?? 'cloud mirror unavailable'}`);
        }
        onCommentsChanged?.(project.id, cloud.filePath);
        return ok(reopen ? `Reopened comment thread ${cloud.id}.` : `Resolved comment thread ${cloud.id}.`);
      },
    },

    listen_comments: {
      description:
        'Subscribe THIS chat to document comments, so every new comment (and reply) arrives here ' +
        'as a message you can act on. Pass `path` to watch one file, or omit it to watch the whole ' +
        'project; pass `stop: true` to unsubscribe. Use it when the user asks you to handle ' +
        'comments as they come in — not on your own initiative.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to watch. Omit to watch every file in the project.' },
          stop: { type: 'boolean', description: 'Stop watching instead of starting.' },
        },
      },
      async execute(input) {
        if (!chatId) return err('No chat to subscribe.');
        if (input.stop === true) {
          store.setCommentWatch(chatId, null);
          return ok('Stopped watching comments.');
        }
        const rel = input.path ? normalizeToolPath(roots(), input.path) : '*';
        if (!rel) return err('Invalid or ignored path');
        // A watch on a nonexistent path can never match — surface the typo
        // now instead of silently receiving nothing (mirrors the cloud tool).
        if (rel !== '*' && (await readCurrentText(rel)) === null) {
          return err(`File does not exist: ${rel}`);
        }
        // share → watch parity: deliveries skip shared chats entirely.
        if (store.chatHasActiveShare(chatId)) {
          return err('This chat is shared via a link — comments are never delivered to shared chats. Stop the share first.');
        }
        store.setCommentWatch(chatId, rel, rel === '*' ? null : store.knownFileId(project.id, rel));
        // Dekker verify like the PATCH route: the share path writes its scope
        // then re-checks the watch, so we re-check shares after writing — a
        // share that raced in rolls this watch back rather than leaving a
        // subscribed chat that deliveries skip (and guests can read).
        if (store.chatHasActiveShare(chatId)) {
          store.setCommentWatch(chatId, null);
          return err('This chat was shared via a link while subscribing — the watch was rolled back. Stop the share first.');
        }
        return ok(
          `Listening for comments on ${rel === '*' ? 'every file in this project' : rel}. New comments arrive as ` +
            'messages in this chat — address each one, then reply briefly with reply_comment and leave the thread ' +
            'open (the commenter resolves it). Call listen_comments with stop: true to turn this off.',
        );
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
        // `spawn`, not `exec`: `detached` is what puts the shell in its OWN
        // process group so a Stop can signal the whole tree, and execFile (which
        // exec builds on) silently DROPS that option — it forwards only a fixed
        // subset to spawn, so the group never formed and `kill(-pid)` returned
        // ESRCH. exec's `signal` has the same blind spot by design: it SIGTERMs
        // /bin/sh alone, leaving a `npm run dev` or a pipeline's children alive
        // on the user's machine after the run is gone. POSIX only — Windows has
        // no process groups to signal, and the sidecar ships on macOS/Linux.
        const groupKill = process.platform !== 'win32';
        // The sidecar ships on macOS/Linux; say so rather than surfacing a raw
        // ENOENT for a path that was never going to exist.
        if (!groupKill) return err('Bash is only available on macOS and Linux.');
        return new Promise((resolve) => {
          const child = spawn('/bin/sh', ['-c', command], { cwd: project.root, env, detached: groupKill });
          let stdout = '';
          let stderr = '';
          // Set ONLY by our own abort handler — never inferred from `killed`,
          // because the timeout below kills the child exactly the same way and
          // a timed-out command reported as "stopped by the user" is a lie.
          let stoppedByUser = false;
          let timedOut = false;
          let settled = false;
          // Whether we actually SIGTERM'd a tree, independent of how the result
          // gets labelled. The headline Stop case — shell long gone, background
          // children killed — is labelled a clean success, so keying the
          // attribution grace off the label would give the one path that just
          // killed live processes the SHORT window, and their final writes
          // would land as 'external' instead of this run's.
          let killed = false;
          const killTree = () => {
            killed = true;
            try {
              if (groupKill && child.pid) process.kill(-child.pid, 'SIGTERM');
              else child.kill('SIGTERM');
            } catch {
              try {
                child.kill('SIGTERM');
              } catch { /* already exited */ }
            }
          };
          // 'exit' fires as soon as the shell is gone; 'close' waits for every
          // writer to its stdio, which can be a BACKGROUND child that outlives
          // it. So `exited` only decides the LABEL — an abort after the shell
          // exited must still signal the group, because those survivors are
          // exactly what Stop is for. Killing and labelling are separate
          // decisions; conflating them let `npm run dev &` (shell exits in
          // milliseconds) become unkillable for the full timeout.
          let exited = false;
          const onAbort = () => {
            if (!exited) stoppedByUser = true;
            killTree();
          };
          const timer = setTimeout(() => {
            if (!exited) timedOut = true;
            killTree();
          }, timeout);
          timer.unref?.();
          child.on('exit', () => {
            exited = true;
          });
          signal?.addEventListener('abort', onAbort, { once: true });
          // An ALREADY-aborted signal never fires the listener. Reachable on
          // the Claude harness in the gap between the abort and the CLI dying,
          // where the command would otherwise run to completion after Stop.
          if (signal?.aborted) onAbort();
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          // Bounded like exec's maxBuffer was, but a chatty command gets
          // CLIPPED rather than failed outright with its output thrown away.
          child.stdout.on('data', (chunk) => {
            if (stdout.length < MAX_BASH_BUFFER) stdout += chunk;
          });
          child.stderr.on('data', (chunk) => {
            if (stderr.length < MAX_BASH_BUFFER) stderr += chunk;
          });
          const settle = (error, code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            // Killing a process group can leave writes landing for a moment
            // after we resolve, so DON'T shrink the window to the usual 2s
            // grace on that path — still bounded, but wide enough to attribute
            // the stragglers to the run that spawned them.
            onBashWindow?.(Date.now() + (killed ? 10_000 : 2_000), holdId);
            const output = clip([stdout, stderr].filter(Boolean).join('\n').trim());
            // This command's OWN fate decides, never the shared run signal: one
            // that exited cleanly microseconds before an unrelated Stop must not
            // be recorded as stopped, or the next turn reads a successful build
            // as cancelled.
            if (stoppedByUser) {
              resolve(err(output ? `${output}\n\n(command stopped by the user)` : 'Command stopped by the user.'));
              return;
            }
            if (timedOut) {
              resolve(err(output ? `${output}\n\n(timed out after ${timeout / 1000}s)` : `Command timed out after ${timeout / 1000}s.`));
              return;
            }
            if (error) {
              resolve(err(output || error.message));
              return;
            }
            if (code !== 0) {
              resolve(err(output || `Command failed with exit code ${code}`));
              return;
            }
            resolve(ok(output || '(no output)'));
          };
          child.on('error', (error) => settle(error, null));
          child.on('close', (code) => settle(null, code));
        });
      },
    },
  };

  // Stop means stop for the whole toolset: a call dispatched before the abort
  // landed must not still touch the disk or the network.
  if (signal) {
    for (const tool of Object.values(tools)) {
      const execute = tool.execute;
      tool.execute = (input) => (signal.aborted ? err('Stopped by the user.') : execute(input));
    }
  }

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
  // `messageId` is the RUN's assistant id, supplied per call: the writer is
  // built before the run exists, and resolving the turn by chat instead would
  // hand a superseded run's still-finishing write to its replacement's chip.
  return async (rel, content, { messageId = null } = {}) => {
    // Suggest mode stages a pending suggestion. Staging can DECLINE a real
    // change it cannot represent as marks (e.g. a spacing-only markdown edit)
    // — fall through to the direct rail then, so a reported-successful write
    // is never silently dropped.
    const staged =
      editMode === 'suggest' &&
      (await docHost.stageAgentSuggestion(project.id, rel, content, { chatId, messageId, authorId }));
    if (!staged) {
      watchers.get(project.id)?.suppress(rel);
      const loc = locateRel(projectRoots(docHost.store, project), rel);
      // First-ever ledger touch of a pre-existing file: snapshot its current
      // text first (same rule as the suggest rail), or the turn's diff has no
      // "before" and the chip renders the whole file as a new-file insertion.
      // Actor 'baseline' — a snapshot, not an edit anyone made.
      const previous = docHost.store.hasEdits(project.id, rel)
        ? null
        : docHost.getLiveText(project.id, rel) ?? (await readTextFile(loc.root, loc.rel).catch(() => null))?.text;
      // `typeof`, not truthiness: an existing EMPTY file's text is '', and
      // skipping its baseline leaves turnEditFiles().existed false — the diff
      // then labels a real edit "Added". null = we never knew the text.
      if (typeof previous === 'string') {
        docHost.store.recordEdit({ projectId: project.id, path: rel, actor: 'baseline', contentText: previous });
      }
      await writeTextFileAtomic(loc.root, loc.rel, content);
      await docHost.handleDiskChange(project.id, rel, { actor: 'agent', chatId, messageId, authorId });
    }
    await bridges.handleLocalFileEvent(project.id, rel);
    emit(project.id, { type: 'files-changed', path: rel });
  };
}
