// Local Codex engine — runs the turn through the user's OWN Codex CLI
// (`codex exec --json`, ChatGPT-subscription auth), entirely on this machine.
//
// Unlike the Claude engine, Codex brings its own shell/patch tools and edits
// the real filesystem directly — attribution rides the watcher: the run holds
// an attribution window (same rail Bash tool calls use) so its disk writes
// land in the ledger as agent/chat rows and stream live into open editors.
// Isolation: `--ephemeral` (no session files), `--ignore-user-config` (the
// user's config.toml/MCP servers/hooks stay out; auth still loads), and
// OPENAI_* env stripped so a stray API key can never be billed. View mode
// maps to `--sandbox read-only` — enforced by Codex's own sandbox.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { modelMessagesToClaudePrompt } from '../../agent-ts/src/harness/history.ts';
import { announcePromptSkills, appendThinkingRow, rowsToModelMessages, rowsUnseenByEngine, systemPrompt, turnEditsMetadata, turnMetaMetadata, writeTurnEditsMetadata } from './runner.mjs';

/** Where `codex` lives: env override, installer paths, nvm globals, PATH. */
export function detectCodexEngine() {
  const home = os.homedir();
  const win = process.platform === 'win32';
  const candidates = [
    process.env.SUNDIAL_CODEX_BIN,
    path.join(home, '.local/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ].filter(Boolean);
  // npm-global installs under nvm never reach a GUI app's PATH — probe the
  // newest node version's bin dir directly.
  try {
    const versions = fs.readdirSync(path.join(home, '.nvm/versions/node')).sort().reverse();
    for (const version of versions) candidates.push(path.join(home, '.nvm/versions/node', version, 'bin/codex'));
  } catch { /* no nvm */ }
  let binary = null;
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      binary = candidate;
      break;
    } catch { /* keep looking */ }
  }
  if (!binary) {
    try {
      const found = execFileSync(win ? 'where.exe' : 'which', ['codex'], { encoding: 'utf8' })
        .split(/\r?\n/)[0]?.trim();
      binary = found || null;
    } catch { /* not on PATH */ }
  }
  const loggedIn = fs.existsSync(path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'auth.json'));
  return { available: Boolean(binary), path: binary, loggedIn };
}

function promptText(messages) {
  const prompt = modelMessagesToClaudePrompt(messages);
  return typeof prompt === 'string' ? prompt : '';
}

// Same trap as claude-runner's: bare `auth`/`login`/`401` matched "author", a
// URL path, "4013 bytes" — any of which swapped the real failure for "you're
// not signed in". Only phrases that can't mean anything else.
const LOGIN_ERROR = /not logged in|codex login|unauthorized|invalid api key|authentication (?:error|failed)|failed to authenticate/i;

/** One turn on the user's Codex. Streams UI chunks + persists rows on the
 *  same contract as the other engines. `holdAttribution(until)` keeps the
 *  project's watcher attributing disk changes to this run. */
export async function runCodexTurn({
  project, chatId, model, editMode, stream, abort, store, log, isReplaced, holdAttribution, settleWatcher, assistantMessageId, external = null,
  // Rows the caller pinned as this turn's context (guest comment deliveries
  // held back — Codex runs with native filesystem access, so a guest prompt
  // must never reach it, not even as history). null = the whole chat.
  historyRows = null,
}) {
  const engine = detectCodexEngine();
  if (!engine.available) {
    throw new Error('Codex isn\'t installed on this machine. Install it (`npm i -g @openai/codex`) and run `codex login`, then try again.');
  }

  // Adopted external session: `codex exec resume <id>` continues the CLI's
  // own thread, so send only the rows it hasn't seen — and no Sunny system
  // prompt, which would otherwise accumulate in the persistent thread each turn.
  // Resume is cwd-sensitive: `codex exec resume` resolves the session from
  // the process cwd, which must be the session's RECORDED cwd (often a
  // project subfolder). A pruned rollout file OR a deleted recorded cwd
  // disables native resume entirely — the imported rows rebuild instead of
  // the CLI erroring on an unresolvable session.
  let resume = null;
  if (external?.agent === 'codex' && external.cwd && fs.existsSync(external.cwd)) {
    const { codexSessionFileExists } = await import('../external-sessions.mjs');
    if (await codexSessionFileExists(external.sessionId)) resume = external.sessionId;
  }
  const cwd = resume ? external.cwd : project.root;
  const rows = historyRows ?? store.listChatMessages(project.id, chatId);
  const messages = rowsToModelMessages(resume ? rowsUnseenByEngine(rows) : rows);
  // Same identity + ground rules as the other engines; Codex reads the
  // conversation as one prompt (its own system prompt stays in charge).
  const extraRoots = store.listExtraRoots(project.id);
  // Codex edits with its NATIVE fs tools — virtual prefixed paths don't exist
  // for it; the prompt must advertise the absolute folders instead.
  const prompt = resume
    ? promptText(messages)
    : `${systemPrompt(project, extraRoots, { nativeFs: true, folderScope: store.getChat(chatId)?.folder_scope || null })}\n\n${promptText(messages)}`;

  const env = { ...process.env };
  // Subscription auth only — a stray OpenAI/Codex API key or access token
  // must never be billed; the sidecar token must never reach a subprocess.
  // (CODEX_HOME stays: it's where the ChatGPT login itself lives.)
  for (const key of Object.keys(env)) {
    if (key.startsWith('OPENAI_') || (key.startsWith('CODEX_') && key !== 'CODEX_HOME')) delete env[key];
  }
  delete env.SUNDIAL_LOCAL_TOKEN;
  // npm/nvm installs are `#!/usr/bin/env node` shims and the desktop app's
  // PATH doesn't include nvm — the shim's own directory has the right node.
  env.PATH = `${path.dirname(engine.path)}${path.delimiter}${env.PATH ?? ''}`;

  // `-` = prompt over stdin: a long transcript as an argv would hit the OS
  // argument-length limit (E2BIG) before Codex even starts.
  // Resumed threads drop --ephemeral: the continuation must persist to
  // ~/.codex/sessions (Codex's own dir) or the NEXT turn has nothing to resume.
  const sandboxMode = editMode === 'view' ? 'read-only' : 'workspace-write';
  const args = [
    'exec', ...(resume ? ['resume', resume] : []), '--json', ...(resume ? [] : ['--ephemeral']),
    '--ignore-user-config', '--skip-git-repo-check',
    // No approval channel exists here (stdin carries the prompt, we only read
    // JSONL) and --ignore-user-config drops any configured policy — pin it so
    // an approval boundary denies cleanly instead of waiting on nobody.
    '-c', 'approval_policy="never"',
    // The resume subcommand rejects exec-only flags (--sandbox, -C): the
    // sandbox rides the -c config form there and the cwd rides the spawn cwd.
    ...(resume ? ['-c', `sandbox_mode="${sandboxMode}"`] : ['--sandbox', sandboxMode]),
    // Extra roots (multi-root mounts) are part of the workspace — writable
    // too. Resumed runs spawn at the session's recorded cwd (possibly a
    // subfolder), so the project root itself must ride writable_roots or
    // sibling/parent workspace files become read-only.
    ...(() => {
      if (editMode === 'view') return [];
      const roots = [...(resume ? [{ root: project.root }] : []), ...extraRoots];
      return roots.length
        ? ['-c', `sandbox_workspace_write.writable_roots=[${roots.map((entry) => JSON.stringify(entry.root)).join(',')}]`]
        : [];
    })(),
    ...(resume ? [] : ['-C', project.root]),
    ...(model?.startsWith('openai/') ? ['-m', model.slice('openai/'.length)] : []),
    '-',
  ];

  stream.write({ type: 'start', messageId: assistantMessageId });
  // Only the first (non-resumed) turn carries the Sundial system prompt, and
  // with it the skill labels. A resumed thread keeps Codex's own context.
  const skillsMeta = resume ? {} : announcePromptSkills({ project, chatId, stream });

  let seq = 0;
  let pendingText = ''; // latest agent_message, not yet persisted
  let sawText = false; // survives a flush — pendingText alone can't answer "did it reply?"
  let persistedReasoning = false; // a thinking row exists, so the turn needs its anchor
  let ranTools = false;
  let turnErrored = null;
  let stderrTail = '';
  let continuedThreadId = null; // the id the NEXT turn resumes
  // Turn-details footer (model · tokens · duration). Codex settles usage on
  // `turn.completed`; the CLI reports no wall clock, so time it here.
  const turnStartedAt = Date.now();
  let turnUsage = null;

  const relPath = (p) => {
    const abs = String(p ?? '');
    const spellings = (root) => {
      const forms = [path.resolve(root)];
      try { forms.push(fs.realpathSync(root)); } catch { /* gone */ }
      return forms;
    };
    for (const root of spellings(project.root)) {
      if (abs === root) return '.';
      if (abs.startsWith(`${root}${path.sep}`)) return abs.slice(root.length + 1);
    }
    // Extra roots display as their mounted (prefixed) virtual paths.
    for (const entry of extraRoots) {
      for (const root of spellings(entry.root)) {
        if (abs === root) return entry.prefix;
        if (abs.startsWith(`${root}${path.sep}`)) return `${entry.prefix}/${abs.slice(root.length + 1)}`;
      }
    }
    return abs;
  };

  const emitText = (text) => {
    if (!text) return;
    const id = `t${seq++}`;
    stream.write({ type: 'text-start', id });
    stream.write({ type: 'text-delta', id, delta: text });
    stream.write({ type: 'text-end', id });
  };

  // An announcement persists as its own row BEFORE the tool rows it precedes
  // (same stream-order rule as the other engines).
  // `streaming: true` marks it IN-FLIGHT (same marker the cloud-step loop and
  // the brain use): only the final anchor row is unmarked, and that asymmetry
  // is what tells reload / gone-recovery the turn actually ended. Without it
  // an announcement reads as a finished reply and recovery stops following a
  // run that's still going.
  // Buffered readline events keep arriving after a soft replace SIGTERMs the
  // CLI, and every per-event write below would land AFTER the replacing turn's
  // user row. persistTool writes complete pairs, so the unmatched-pair pruning
  // cannot clean that up — it has to not happen. Same corruption class the
  // cloud-step loop guards against.
  const flushPendingText = () => {
    if (isReplaced?.()) return;
    if (pendingText.trim()) {
      store.appendChatMessage(project.id, chatId, {
        role: 'assistant',
        content: pendingText,
        metadata: { streaming: true },
      });
    }
    pendingText = '';
  };

  const persistTool = (toolCallId, name, input, output, isError) => {
    ranTools = true;
    if (isReplaced?.()) return;
    flushPendingText();
    store.appendChatMessage(project.id, chatId, {
      role: 'system',
      content: '',
      metadata: { type: 'tool_use', tool_use_id: toolCallId, tool: { name, input } },
    });
    stream.write({ type: 'tool-input-start', toolCallId, toolName: name });
    stream.write({ type: 'tool-input-available', toolCallId, toolName: name, input });
    store.appendChatMessage(project.id, chatId, {
      role: 'system',
      content: output,
      metadata: { type: 'tool_result', tool_use_id: toolCallId, tool_name: name, is_error: isError },
    });
    stream.write(
      isError
        ? { type: 'tool-output-error', toolCallId, errorText: output }
        : { type: 'tool-output-available', toolCallId, output },
    );
    log?.(`local-codex tool=${name} error=${Boolean(isError)} chat=${chatId}`);
  };

  const onEvent = (event) => {
    const item = event?.item;
    switch (event?.type) {
      case 'thread.started': {
        if (typeof event.thread_id === 'string') continuedThreadId = event.thread_id;
        break;
      }
      case 'item.completed': {
        if (!item) break;
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          // Two messages in a row: the earlier one persists as its own row;
          // the LAST one becomes the anchored reply row after the loop.
          flushPendingText();
          emitText(item.text);
          pendingText = item.text;
          // `.trim()`: an EMPTY agent_message must not count as a reply, or a
          // CLI that said nothing skips the actionable "run codex once in a
          // terminal" failure and persists a blank anchor marked completed —
          // a silent empty bubble, the exact outcome that gate exists to stop.
          if (item.text.trim()) sawText = true;
        } else if (item.type === 'reasoning' && typeof item.text === 'string' && item.text.trim()) {
          const id = `r${seq++}`;
          // Persisted as well as streamed, in stream order — otherwise any
          // reconnect + history reconcile wiped the reasoning and the
          // transcript showed a bare "Thinking…".
          // Flushing clears pendingText, which is ALSO how the turn decides it
          // produced a reply — `sawText` remembers that independently, or a
          // reasoning item after the last message would make the turn look
          // like a CLI that returned nothing (failure) and leave the flushed
          // row wearing the in-flight marker with no anchor behind it.
          flushPendingText();
          if (!isReplaced?.() && appendThinkingRow(store, project.id, chatId, item.text)) persistedReasoning = true;
          stream.write({ type: 'reasoning-start', id });
          stream.write({ type: 'reasoning-delta', id, delta: item.text });
          stream.write({ type: 'reasoning-end', id });
        } else if (item.type === 'command_execution') {
          persistTool(
            item.id ?? `codex-${seq++}`,
            'Bash',
            { command: String(item.command ?? '') },
            String(item.aggregated_output ?? '').trim() || '(no output)',
            typeof item.exit_code === 'number' && item.exit_code !== 0,
          );
        } else if (item.type === 'file_change') {
          const changes = Array.isArray(item.changes) ? item.changes : [];
          for (const change of changes) {
            persistTool(
              `${item.id ?? `codex-${seq}`}-${relPath(change.path)}`,
              'Edit',
              { file_path: relPath(change.path) },
              `${change.kind === 'add' ? 'Created' : change.kind === 'delete' ? 'Deleted' : 'Updated'} ${relPath(change.path)}`,
              false,
            );
          }
        }
        break;
      }
      case 'turn.failed':
      case 'error': {
        turnErrored = String(event?.error?.message ?? event?.message ?? event?.type);
        break;
      }
      case 'turn.completed': {
        // Top-level `error` events can be TRANSIENT (stream reconnects) — a
        // turn that completes afterwards ended successfully.
        turnErrored = null;
        if (event.usage && typeof event.usage === 'object') turnUsage = event.usage;
        break;
      }
      default:
        break;
    }
  };

  // Attribution covers the WHOLE run, event silence included (a long command
  // can write files 30s+ after the last JSON event) — refreshed on a timer
  // from spawn to close, then a short grace for the watcher's debounce.
  // View mode runs a read-only sandbox: no agent writes are possible, so no
  // hold — a human saving a file mid-turn must not attribute as the agent.
  const hold = editMode === 'view' ? null : holdAttribution;
  hold?.(Date.now() + 20_000);
  const holdRefresh = setInterval(() => hold?.(Date.now() + 20_000), 10_000);
  holdRefresh.unref?.();
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      let child;
      try {
        // Windows npm installs are .cmd shims — not directly spawnable. Run
        // them through the shell with explicit cmd.exe quoting (the prompt
        // rides stdin, so args are just flags + paths).
        const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(engine.path);
        child = shim
          ? spawn(
              [engine.path, ...args].map((part) => `"${String(part).replace(/"/g, '""')}"`).join(' '),
              { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: true },
            )
          : spawn(engine.path, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        reject(error);
        return;
      }
      child.stdin.on('error', () => {}); // a fast-exiting CLI can close stdin first
      child.stdin.end(prompt);
      const onAbort = () => child.kill('SIGTERM');
      abort.signal.addEventListener('abort', onAbort, { once: true });
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        if (!line.trim()) return;
        try {
          onEvent(JSON.parse(line));
        } catch { /* non-JSON noise */ }
      });
      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + String(chunk)).slice(-2000);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        abort.signal.removeEventListener('abort', onAbort);
        resolve(code ?? 0);
      });
    });
  } catch (error) {
    // A failed launch wrote nothing — expire this run's hold immediately so
    // unrelated edits in the window can't be misattributed to it.
    hold?.(0);
    throw error;
  } finally {
    clearInterval(holdRefresh);
  }
  hold?.(Date.now() + 3_000); // grace for the watcher's debounce
  // …and actually WAIT for that debounce to drain. The hold only keeps the
  // attribution window open; without settling, the count below can run before
  // the watcher has inserted this turn's rows, persist `{}` as the assistant
  // metadata, and the chat diff chip never renders for a turn that did edit.
  await settleWatcher?.();

  if (isReplaced()) return;
  if (resume && continuedThreadId && continuedThreadId !== resume) {
    store.updateChat(chatId, { external_resume_id: continuedThreadId });
  }

  // Codex edits the disk natively, so the turn's rows arrive through the
  // watcher — read the count once, here, after its debounce grace above.
  const editsMeta = { ...skillsMeta, ...turnEditsMetadata(store, project.id, assistantMessageId) };
  // `input_tokens` is OpenAI-shaped (cache reads INCLUDED), matching what the
  // cloud openai lane persists.
  const turnMeta = turnMetaMetadata({
    model,
    inputTokens: turnUsage?.input_tokens,
    outputTokens: turnUsage?.output_tokens,
    durationMs: Date.now() - turnStartedAt,
  });
  if (abort.signal.aborted) {
    // User stop — persist whatever the turn produced so far. A thinking row
    // counts: without its anchor it flushes under a synthetic id, reads as
    // outcome 'none', and the client retries for minutes.
    if (pendingText.trim() || ranTools || persistedReasoning) {
      store.appendChatMessage(project.id, chatId, {
        id: assistantMessageId,
        role: 'assistant',
        content: pendingText,
        metadata: pendingText.trim() || ranTools
          ? { ...editsMeta, ...turnMeta }
          : { ...editsMeta, ...turnMeta, run_status: 'aborted' },
      });
    }
    writeTurnEditsMetadata(stream, editsMeta);
    stream.write({ type: 'finish', finishReason: 'stop' });
    return;
  }

  // A CLI that never got going (not onboarded, unusable model) can exit 0
  // having printed nothing — finishing clean there is a silent non-reply.
  // `sawText`, not pendingText: a reasoning item after the last message
  // FLUSHES pendingText, and judging by it alone would call a turn that
  // replied perfectly well a CLI that returned nothing.
  const replied = sawText || pendingText.trim() || ranTools;
  const failure =
    turnErrored ||
    (exitCode !== 0 ? stderrTail.trim() || `codex exited with code ${exitCode}` : null) ||
    (!replied
      ? stderrTail.trim() || 'it returned nothing — run `codex` once in a terminal to finish setup and sign in, then try again'
      : null);
  if (failure && !replied) {
    // Nothing streamed — fail the turn outright, with an actionable message.
    throw new Error(
      LOGIN_ERROR.test(failure)
        ? 'Codex isn\'t signed in on this computer. Run `codex login` in a terminal, then try again.'
        : `Codex failed: ${failure.slice(0, 300)}`,
    );
  }
  if (replied || failure) {
    // Contentless anchor (reasoning-only, or a reply already flushed by a
    // trailing reasoning item) needs a terminal marker, or latestTurnOutcome
    // reads the turn as still running.
    const terminal = pendingText.trim() || ranTools || failure ? {} : { run_status: 'completed' };
    store.appendChatMessage(project.id, chatId, {
      id: assistantMessageId,
      role: 'assistant',
      content: pendingText,
      metadata: failure
        ? { ...editsMeta, ...turnMeta, run_status: 'error', run_error: `Codex stopped before finishing (${failure.slice(0, 200)}).` }
        : { ...editsMeta, ...turnMeta, ...terminal },
    });
  }
  writeTurnEditsMetadata(stream, editsMeta);
  if (failure) {
    stream.write({ type: 'error', errorText: `Codex stopped before finishing (${failure.slice(0, 200)}).` });
    return;
  }
  stream.write({ type: 'finish', finishReason: 'stop' });
}
