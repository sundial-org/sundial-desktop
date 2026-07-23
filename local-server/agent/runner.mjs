// Local Sunny's agent loop.
//
// The sidecar owns the loop; the cloud owns the models. Each iteration POSTs
// the conversation + JSON-schema tool defs to /api/agent/local-step (auth +
// credit gate + metering) and streams back ONE model step as a UI Message
// Stream. Tools carry no execute functions cloud-side, so a step ends at the
// model's tool calls — we run them here (disk, DocHost, Bash) and post the
// next step with the results appended.
//
// Browser contract: the merged stream we serve from /agent-stream is the same
// UI Message Stream a cloud turn produces — per-step 'start'/'finish' frames
// are stripped (ours bracket the whole turn), chunk part ids are step-prefixed
// so they can't collide, and executed tool results are injected as
// 'tool-output-available' chunks. Resume is a character-offset replay of the
// SSE text, mirroring resumable-stream's Last-Event-ID semantics.

import { randomUUID } from 'node:crypto';

import { createLocalTools, engineAuthorId, toolDefinitions } from './tools.mjs';

const MAX_STEPS = 24;

const sseFrame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;

export class RunStream {
  constructor() {
    this.id = randomUUID();
    this.text = '';
    this.subscribers = new Set(); // res objects
    this.done = false;
  }

  write(chunk) {
    const frame = sseFrame(chunk);
    this.text += frame;
    for (const res of this.subscribers) res.write(frame);
  }

  finish() {
    const frame = 'data: [DONE]\n\n';
    this.text += frame;
    this.done = true;
    for (const res of this.subscribers) {
      res.write(frame);
      res.end();
    }
    this.subscribers.clear();
  }

  /** Attach an SSE response, replaying from a character offset. */
  subscribe(res, offset = 0) {
    const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.min(offset, this.text.length) : 0;
    res.write(this.text.slice(safeOffset));
    if (this.done) {
      res.end();
      return () => {};
    }
    this.subscribers.add(res);
    return () => this.subscribers.delete(res);
  }
}

export function systemPrompt(project, extraRoots = [], { nativeFs = false } = {}) {
  // The prefixed virtual paths exist only inside the Sundial file tools —
  // a native-fs engine (Codex CLI) or a shell command must use absolute
  // paths, or `prefix/...` would create files under the primary root.
  const mounts = extraRoots.length
    ? nativeFs
      ? `\nAdditional folders belong to this workspace (outside the working directory — address them by ABSOLUTE path):\n${extraRoots
          .map((entry) => `- ${entry.root}`)
          .join('\n')}\n`
      : `\nAdditional folders mounted into the workspace:\n${extraRoots
          .map((entry) => `- ${entry.prefix}/ → ${entry.root}`)
          .join('\n')}\nUse the prefixed relative paths (e.g. ${extraRoots[0].prefix}/file.md) in Read/Write/Edit/Glob/Grep. In Bash those mounted paths do NOT exist under the working directory — use the absolute path instead.\n`
    : '';
  return `You are Sunny, Sundial's embedded agent, running LOCALLY against a folder on the user's computer.

Project: "${project.name}" at ${project.root}.
${mounts}
- File paths in tool calls are relative to the project root.
- Read/Glob/Grep see the live project (unsaved editor keystrokes included). Write/Edit apply instantly in any open editor and are attributed to you.
- Bash: there is NO sandbox here — commands run directly on the user's real machine, in the project folder. Be conservative: no destructive commands beyond what the user asked for, and never touch files outside the project without being asked. Bash timeouts are in seconds.
- Grep patterns are JavaScript regular expressions (use \\b for word boundaries; \\m and \\y are not supported).
- Everything stays on this machine except the conversation itself, which is sent to the model provider to generate replies.
- Prefer editing existing files over creating new ones; keep replies concise.`;
}

/** Extract plain text from a stored user row for the model conversation. */
const rowText = (row) => (typeof row.content === 'string' ? row.content : '');

/** Stored chat rows → AI SDK-shaped ModelMessages. Tool rows are folded into
 *  the assistant/tool message pair the model API expects, and long chats are
 *  windowed to the tail, cutting only at a USER message boundary so a
 *  tool-call/tool-result pair is never orphaned (the step endpoint caps at
 *  400 messages and models reject dangling results). */
export function rowsToModelMessages(rows) {
  const messages = [];
  for (const row of rows) {
    const meta = row.metadata ?? {};
    if (row.role === 'user') {
      messages.push({ role: 'user', content: rowText(row) });
    } else if (row.role === 'assistant') {
      if (rowText(row).trim()) messages.push({ role: 'assistant', content: rowText(row) });
    } else if (meta.type === 'tool_use' && meta.tool?.name) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: meta.tool_use_id, toolName: meta.tool.name, input: meta.tool.input ?? {} }],
      });
    } else if (meta.type === 'tool_result') {
      messages.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: meta.tool_use_id,
          toolName: meta.tool_name ?? 'tool',
          output: { type: meta.is_error ? 'error-text' : 'text', value: rowText(row) },
        }],
      });
    }
  }
  if (messages.length > 300) {
    let start = messages.length - 300;
    while (start < messages.length && messages[start].role !== 'user') start += 1;
    if (start >= messages.length) {
      start = messages.map((m) => m.role).lastIndexOf('user');
    }
    if (start > 0) messages.splice(0, start);
  }
  return messages;
}

/** Rows an engine continuing its OWN session hasn't seen: everything after
 *  the last row the engine's session file already holds — a clean assistant
 *  reply, an imported transcript row, or an errored turn that streamed real
 *  work before failing (text or tool activity means the engine received and
 *  recorded the turn; replaying its stale tool rows would corrupt the
 *  continuation). Only an EMPTY pre-start failure is NOT a boundary: the
 *  engine never saw that prompt, and the retry must re-send it — a repeated
 *  question is benign where a dropped one is data loss. */
export function rowsUnseenByEngine(rows) {
  const engineSaw = (row, index) => {
    if (row.metadata?.imported === true) return true;
    if (row.role !== 'assistant') return false;
    if (!row.metadata?.run_status) return true;
    if (typeof row.content === 'string' && row.content.trim()) return true;
    // Empty errored row: a boundary only if its turn streamed tool/thinking
    // rows before failing (scan back to the turn's user message).
    for (let i = index - 1; i >= 0; i -= 1) {
      if (rows[i].role !== 'system') return false;
      if (rows[i].metadata?.type) return true;
    }
    return false;
  };
  return rows.slice(rows.findLastIndex(engineSaw) + 1);
}

export class LocalAgentHost {
  constructor({ store, docHost, log = () => {} }) {
    this.store = store;
    this.docHost = docHost;
    this.log = log;
    this.runs = new Map(); // chatId -> { stream, abort }
    this.bashWindows = new Map(); // projectId -> Map<'chatId runId [holdId]', { until, editMode }>
  }

  /** Watcher attribution for disk changes made outside the agent writer
   *  (Bash tool calls; the Codex engine's whole run): during an active hold
   *  window (+ a grace covering the watcher debounce) the project's disk
   *  events belong to the run. Windows are keyed PER RUN — a superseded
   *  run's late grace call must never clobber its replacement's hold — and
   *  fold to chat ids here. Two chats overlapping is ambiguous: still the
   *  agent's work, but no single chat can be claimed. */
  bashAttribution(projectId) {
    const windows = this.bashWindows.get(projectId);
    if (!windows) return null;
    const now = Date.now();
    const chats = new Set();
    let allSuggest = true;
    for (const [key, window] of windows) {
      if (window.until > now) {
        chats.add(key.split(' ')[0]);
        if (window.editMode !== 'suggest') allSuggest = false;
      } else windows.delete(key);
    }
    if (chats.size === 0) return null;
    // Engine identity for the ledger: Bash writes bypass the agent writer, so
    // this is where claude-code vs codex attribution for disk changes comes
    // from. Ambiguous only if overlapping chats run DIFFERENT engines.
    const engines = new Set([...chats].map((id) => engineAuthorId(this.store.getChat(id)?.harness)));
    // editMode 'suggest' only when EVERY active window is a suggest-mode run —
    // overlapping mixed-mode runs are ambiguous, and a direct apply is the
    // recoverable default (a wrongly-staged suggestion looks like agent spam).
    return {
      actor: 'agent',
      chatId: chats.size === 1 ? [...chats][0] : null,
      authorId: engines.size === 1 ? [...engines][0] : null,
      editMode: allSuggest ? 'suggest' : 'edit',
    };
  }

  activeStream(chatId) {
    return this.runs.get(chatId)?.stream ?? null;
  }

  interrupt(chatId) {
    const run = this.runs.get(chatId);
    if (!run) return false;
    run.abort.abort();
    return true;
  }

  /** Kick (or cancel-and-replace) the run for a chat. Fire-and-forget. */
  start({ project, chatId, model, harness, credentials, writeText, editMode }) {
    this.interrupt(chatId);
    const stream = new RunStream();
    const abort = new AbortController();
    const run = { stream, abort };
    this.runs.set(chatId, run);
    void this.run({ project, chatId, model, harness, credentials, writeText, editMode, stream, abort })
      .catch((error) => {
        this.log(`local-agent run failed chat=${chatId} error=${error?.message}`);
        const errorText = error?.message ?? 'Agent run failed';
        // A startup failure (login, spawn, fetch) throws before any assistant
        // anchor persisted — without one, reload shows a turn that looks
        // in-flight and the diagnostic is gone. Skip interrupts/replacements
        // (not failures) and runs that already recorded their failure.
        if (!abort.signal.aborted) {
          try {
            const last = this.store.listChatMessages(project.id, chatId).at(-1);
            if (!(last?.role === 'assistant' && last?.metadata?.run_status)) {
              this.store.appendChatMessage(project.id, chatId, {
                role: 'assistant',
                content: '',
                metadata: { run_status: 'error', run_error: errorText },
              });
            }
          } catch { /* best-effort — the live stream still errors below */ }
        }
        stream.write({ type: 'error', errorText });
      })
      .finally(() => {
        stream.finish();
        // Keep the finished stream replayable briefly: a fast turn (or an
        // immediate credentials error) can finish before the browser's first
        // GET, which must replay it — not 404 into "no active stream".
        setTimeout(() => {
          if (this.runs.get(chatId) === run) this.runs.delete(chatId);
        }, 60_000).unref?.();
      });
    return stream;
  }

  async run({ project, chatId, model, harness, credentials, writeText, editMode, stream, abort }) {
    const { store, docHost, log } = this;
    // Watcher-attribution hold: disk writes inside the window belong to this
    // run (Bash tool calls; the Codex engine's entire turn). Keyed by run
    // (stream id) so replacement runs never fight over one window, plus an
    // optional per-invocation holdId so a short Bash call finishing first
    // can't shorten an overlapping longer one's still-active window.
    const holdAttribution = (until, holdId = '') => {
      const windows = this.bashWindows.get(project.id) ?? new Map();
      windows.set(`${chatId} ${stream.id}${holdId ? ` ${holdId}` : ''}`, { until, editMode });
      this.bashWindows.set(project.id, windows);
    };
    // Adopted external session (Import/Resume): the engine continues its OWN
    // session natively instead of replaying the rebuilt history. Resume from
    // the live fork when one exists; the original id stays put for exclusion.
    const chatRow = store.getChat(chatId);
    const external = chatRow?.external_session_id
      ? {
          agent: chatRow.external_agent,
          sessionId: chatRow.external_resume_id || chatRow.external_session_id,
          // Recorded at import: the scanner's budgets can age the original
          // file out, so the cwd must not depend on a re-scan.
          cwd: chatRow.external_cwd,
        }
      : null;
    // The Codex engine drives the user's own `codex` CLI — its native tools
    // edit the real filesystem, attributed through the watcher hold.
    if (harness === 'openai') {
      const { runCodexTurn } = await import('./codex-runner.mjs');
      await runCodexTurn({
        project, chatId, model, editMode, stream, abort, store, log, holdAttribution, external,
        isReplaced: () => this.activeStream(chatId) !== stream,
      });
      return;
    }
    const allTools = createLocalTools({
      project,
      docHost,
      writeText,
      onBashWindow: holdAttribution,
      // Claude engine: Bash children get the same sanitized env as the CLI —
      // stray provider keys in the sidecar's env stay out of shell commands.
      bashEnv: harness === 'claude' ? (await import('./claude-runner.mjs')).sanitizedEnv() : null,
    });
    // Viewing mode is a HARD permission boundary: read-only toolset, no Bash
    // (it can write too). Suggest mode keeps the full toolset — Write/Edit
    // stage as pending suggestions through the DocHost rail, and Bash disk
    // writes stage via the watcher's suggest-mode attribution window.
    const tools =
      editMode === 'view'
        ? Object.fromEntries(Object.entries(allTools).filter(([name]) => ['Read', 'Glob', 'Grep'].includes(name)))
        : allTools;

    // The Claude engine runs the whole turn through the user's own Claude
    // Code (subscription auth, no cloud step, no credits) — same tools, same
    // stream + persistence contract.
    if (harness === 'claude') {
      const { runClaudeTurn } = await import('./claude-runner.mjs');
      await runClaudeTurn({
        project, chatId, model, editMode, tools, stream, abort, store, log, external,
        isReplaced: () => this.activeStream(chatId) !== stream,
      });
      return;
    }
    const defs = toolDefinitions(tools);

    // Conversation so far → ModelMessages.
    const messages = rowsToModelMessages(store.listChatMessages(project.id, chatId));

    const system =
      systemPrompt(project, store.listExtraRoots(project.id)) +
      (editMode === 'view'
        ? '\n\nThe user has this document in VIEWING mode: you are READ-ONLY this turn. Do not attempt writes.'
        : '');
    const assistantMessageId = randomUUID();
    stream.write({ type: 'start', messageId: assistantMessageId });

    let assistantText = '';
    let ranTools = false;
    try {
    for (let step = 0; step < MAX_STEPS; step += 1) {
      if (abort.signal.aborted) break;
      const response = await fetch(`${credentials.apiOrigin}/api/agent/local-step`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credentials.token}`,
        },
        body: JSON.stringify({ chatId, model, system, messages, tools: defs }),
        signal: abort.signal,
      });
      if (response.status === 401 || response.status === 402) {
        const body = await response.json().catch(() => ({}));
        if (response.status === 401) store.setAgentCredentials(null); // token invalid — re-mint on next send
        stream.write({
          type: 'error',
          errorText:
            body?.reason === 'out_of_credits'
              ? "You're out of AI credits. Add credits in the cloud app to keep going."
              : 'Sign in to chat with Sunny.',
        });
        return;
      }
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '');
        throw new Error(`model step failed (${response.status}) ${detail.slice(0, 200)}`);
      }

      const { toolCalls, text } = await this.consumeStep(response.body, stream, step, abort.signal);

      if (toolCalls.length === 0) {
        assistantText += text;
        break;
      }
      ranTools = true;
      // Persist this step's text BEFORE its tool rows: on reload,
      // rowsToUIMessages renders rows in order, so "I'll edit it" must land
      // ahead of the Edit call it announced, not merged into the final row.
      if (text.trim()) {
        store.appendChatMessage(project.id, chatId, { role: 'assistant', content: text, metadata: {} });
      }

      // The step's assistant message (tool calls + any interleaved text).
      messages.push({
        role: 'assistant',
        content: [
          ...(text.trim() ? [{ type: 'text', text }] : []),
          ...toolCalls.map((call) => ({
            type: 'tool-call',
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: call.input ?? {},
          })),
        ],
      });

      for (const call of toolCalls) {
        store.appendChatMessage(project.id, chatId, {
          role: 'system',
          content: '',
          metadata: { type: 'tool_use', tool_use_id: call.toolCallId, tool: { name: call.toolName, input: call.input ?? {} } },
        });
        let result;
        try {
          const tool = tools[call.toolName];
          result = tool
            ? await tool.execute(call.input ?? {})
            : { isError: true, content: `Unknown tool: ${call.toolName}` };
        } catch (error) {
          result = { isError: true, content: error?.message ?? 'Tool failed' };
        }
        log(`local-agent tool=${call.toolName} error=${result.isError} chat=${chatId}`);
        store.appendChatMessage(project.id, chatId, {
          role: 'system',
          content: result.content,
          metadata: { type: 'tool_result', tool_use_id: call.toolCallId, tool_name: call.toolName, is_error: result.isError },
        });
        stream.write(
          result.isError
            ? { type: 'tool-output-error', toolCallId: call.toolCallId, errorText: result.content }
            : { type: 'tool-output-available', toolCallId: call.toolCallId, output: result.content },
        );
        messages.push({
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { type: result.isError ? 'error-text' : 'text', value: result.content },
          }],
        });
      }
    }
    } catch (error) {
      // A user Stop aborts the in-flight step fetch — that's a clean end of
      // turn, not an agent failure. Persist what streamed and finish quietly.
      if (!abort.signal.aborted) throw error;
      // …UNLESS this run was cancel-and-REPLACED: the new send's user row is
      // already appended, so persisting the superseded turn's partial text
      // now would land it after that row and corrupt transcript order.
      if (this.activeStream(chatId) !== stream) return;
    }

    // A cancel-and-REPLACED run must not persist anything after the new
    // send's user row — same rule as the catch path above, re-checked here
    // because an abort can also end the loop cleanly (between steps, or the
    // step stream closing without throwing).
    if (this.activeStream(chatId) !== stream) return;
    // Steps that ran tools already persisted their text in order; this row is
    // the final (tool-less) step's reply. Skip it only when the whole turn is
    // empty AND ran no tools (an interrupted turn's tail would render as a
    // blank bubble on reload). A tool turn always persists it — even empty —
    // because it carries assistantMessageId: without that anchor,
    // rowsToUIMessages flushes the tool rows under a synthetic id and
    // reconnect/gone-history recovery can duplicate the streamed message.
    if (assistantText.trim() || ranTools) {
      store.appendChatMessage(project.id, chatId, {
        id: assistantMessageId,
        role: 'assistant',
        content: assistantText,
        metadata: {},
      });
    }
    // finishReason is the client's "turn ended cleanly" signal: without it,
    // shouldAutoResume treats the closed SSE as severed mid-turn and
    // resumeStream replays this finished stream in a loop (React max-depth).
    stream.write({ type: 'finish', finishReason: 'stop' });
  }

  /** Read one cloud step's SSE, forwarding chunks to the browser stream (with
   *  per-step id prefixes; per-step start/finish stripped) and collecting the
   *  step's text + tool calls for the loop. */
  async consumeStep(body, stream, step, signal) {
    const toolCalls = [];
    let text = '';
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const prefix = (id) => (typeof id === 'string' ? `s${step}-${id}` : id);

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary === -1) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('');
        if (!data || data === '[DONE]') continue;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        switch (chunk.type) {
          case 'start':
          case 'finish':
          case 'start-step':
          case 'finish-step':
            // Turn-level frames are ours; step frames add nothing locally.
            continue;
          case 'text-delta':
            text += chunk.delta ?? '';
            stream.write({ ...chunk, id: prefix(chunk.id) });
            continue;
          case 'tool-input-available':
            toolCalls.push({ toolCallId: chunk.toolCallId, toolName: chunk.toolName, input: chunk.input });
            stream.write(chunk);
            continue;
          default:
            stream.write('id' in chunk ? { ...chunk, id: prefix(chunk.id) } : chunk);
        }
      }
    }
    return { toolCalls, text };
  }
}
