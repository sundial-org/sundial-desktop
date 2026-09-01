// Local Claude engine — runs the turn through the user's OWN Claude Code
// install (subscription auth) via the Claude Agent SDK, entirely on this
// machine: no cloud step endpoint, no sign-in, no credits.
//
// Same contract as the cloud-step loop in runner.mjs: the sidecar's local
// tools (attributed DocHost writes, real Bash) are exposed to the CLI as an
// in-process MCP server, `toolAliases` maps the bare names the model is
// trained on (Read/Edit/Bash…) onto them so the CLI's native filesystem tools
// never bypass attribution, and streamed chunks + persisted rows are
// byte-compatible with a cloud turn — the browser can't tell engines apart.
//
// Auth is the CLI's own login (keychain OAuth): ANTHROPIC_* env is stripped so
// a stray API key can never be billed, and `settingSources: []` keeps the
// user's personal CLAUDE.md/hooks/permissions out of Sundial runs.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { modelMessagesToClaudePrompt } from '../../agent-ts/src/harness/history.ts';
import { appendThinkingRow, rowsUnseenByEngine, rowsToModelMessages, systemPrompt, topUpTurnEdits, turnEditsMetadata, writeTurnEditsMetadata } from './runner.mjs';

const MCP_PREFIX = 'mcp__sundial__';

const stripPrefix = (name) => (name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name);

/** Where `claude` lives: env override, the installers' fixed paths, then PATH.
 *  Logged-in is a UI hint only (the CLI is authoritative at run time) — the
 *  login-metadata read never blocks a run. */
export function detectClaudeEngine() {
  const home = os.homedir();
  const win = process.platform === 'win32';
  const candidates = [
    process.env.SUNDIAL_CLAUDE_BIN,
    path.join(home, '.local/bin/claude'),
    path.join(home, '.claude/local/claude'),
    ...(win ? [path.join(home, '.local/bin/claude.exe'), path.join(home, '.claude/local/claude.exe')] : ['/opt/homebrew/bin/claude', '/usr/local/bin/claude']),
  ].filter(Boolean);
  // npm-global installs under nvm never reach a GUI app's PATH — probe the
  // newest node version's bin dir directly.
  try {
    const versions = fs.readdirSync(path.join(home, '.nvm/versions/node')).sort().reverse();
    for (const version of versions) candidates.push(path.join(home, '.nvm/versions/node', version, 'bin/claude'));
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
      const found = execFileSync(win ? 'where.exe' : 'which', ['claude'], { encoding: 'utf8' })
        .split(/\r?\n/)[0]?.trim();
      binary = found || null;
    } catch { /* not on PATH */ }
  }
  let loggedIn = false;
  try {
    loggedIn = Boolean(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).oauthAccount);
  } catch { /* never logged in (or file moved) */ }
  if (!loggedIn) loggedIn = fs.existsSync(path.join(home, '.claude', '.credentials.json'));
  return { available: Boolean(binary), path: binary, loggedIn };
}

async function loadSdk() {
  try {
    return await import('../../agent-ts/src/harness/sdk-exports.ts');
  } catch (error) {
    throw new Error(
      `The local Claude engine isn't available in this build (${error?.message ?? 'SDK import failed'}). In development, run pnpm install inside agent-ts/ first.`,
    );
  }
}

/** Our JSON-schema tool inputs (flat string/number/boolean props) → the zod
 *  raw shape the SDK's `tool()` takes. */
function zodShape(schema) {
  const required = new Set(schema?.required ?? []);
  const shape = {};
  for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
    let field = prop.type === 'number' ? z.number() : prop.type === 'boolean' ? z.boolean() : z.string();
    if (prop.description) field = field.describe(prop.description);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

function buildMcpServer(sdk, tools) {
  const sdkTools = Object.entries(tools).map(([name, def]) =>
    sdk.tool(name, def.description ?? '', zodShape(def.inputSchema), async (args) => {
      let result;
      try {
        result = await def.execute(args ?? {});
      } catch (error) {
        result = { isError: true, content: error?.message ?? 'Tool failed' };
      }
      // An image Read hands back bytes alongside its label — forward them as
      // an MCP image block, or this engine would report a SUCCESSFUL Read
      // carrying nothing but a filename and the model would answer from thin
      // air (the exact retry/hallucination loop the honest error avoided).
      return {
        content: [
          { type: 'text', text: result.content ?? '' },
          ...(result.image ? [{ type: 'image', data: result.image.data, mimeType: result.image.mediaType }] : []),
        ],
        ...(result.isError ? { isError: true } : {}),
      };
    }),
  );
  return sdk.createSdkMcpServer({ name: 'sundial', version: '1.0.0', tools: sdkTools });
}

/** Pull the text out of an Anthropic tool_result block's content. */
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === 'object' && b.type === 'text' ? b.text ?? '' : '')).join('');
  }
  return '';
}

// Unambiguous sign-in signals ONLY. A bare `oauth` alternative matched any
// line merely carrying the word — a URL, a transient refresh warning, an
// unrelated stderr tail (which `withStderr` appends BEFORE this runs) — and
// answered it with "you're not signed in": wrong advice, and it replaced the
// real error instead of showing it. Anchor to what the CLI actually prints.
const LOGIN_ERROR = /please run \/login|invalid api key|not logged in|authentication_error|failed to authenticate|oauth (?:session|token) (?:expired|invalid|revoked)/i;

// A CLI that dies during startup (never onboarded, unusable --model, a crash)
// can exit 0 having printed NOTHING: the SDK ends its stream without a result
// and without throwing. That used to finish the turn clean and silent — the
// user saw no reply, no error, nothing at all.
// "Sign in" is the wrong advice for the daily user who IS signed in, so the
// ask is neutral: run the same CLI in a terminal and see what it says.
const NO_OUTPUT =
  'Claude Code ran but returned nothing — open a terminal, run `claude` there once to see what it says, then try again.';

/** Silent exit, empty stderr: the CLI told us NOTHING, and "sign in" is the
 *  wrong advice for the daily user whose CLI simply can't start here. Ask the
 *  binary what it is — `--version` needs no auth, no network and no tokens —
 *  which separates "can't start from a GUI app" (missing runtime on the
 *  desktop app's minimal PATH, broken install) from "started fine and said
 *  nothing", and names the exact build to report. */
export function diagnoseSilence(binary, env) {
  if (!binary) return NO_OUTPUT;
  try {
    const version = execFileSync(binary, ['--version'], { env, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    // A silent `--version` is itself the answer: whatever that file is, it
    // isn't a working Claude Code.
    if (version) return `${NO_OUTPUT} (${binary}, ${version})`;
    throw new Error('`--version` printed nothing');
  } catch (error) {
    const detail = String(error?.stderr || error?.message || '').trim().slice(0, 200);
    return `Claude Code at ${binary} won't start from the Sundial app${detail ? `: ${detail}` : ''}.`;
  }
}

export function friendlyClaudeError(error) {
  const message = (error instanceof Error ? error.message : String(error)).trim();
  if (LOGIN_ERROR.test(message)) {
    // Name the reason. "Signed in" is exactly what the user believes they are,
    // so the bare advice reads as flat-out wrong and they ignore it; the CLI's
    // own words (an expired OAuth session, a rejected key) are what make it
    // actionable and what they can report back.
    return new Error(`Claude Code isn't signed in on this computer (${message.slice(0, 200)}). Run \`claude login\` in a terminal, then try again.`);
  }
  if (/ENOENT|not found|failed to launch/i.test(message)) {
    return new Error('Claude Code isn\'t installed on this machine. Install it and run `claude login`, then try again.');
  }
  if (!message) return new Error(NO_OUTPUT);
  return error instanceof Error ? error : new Error(message);
}

/** Subscription auth only: the CLI's own stored login. A stray ANTHROPIC_*
 *  key/base-url in the sidecar's env must never leak into (or get billed by)
 *  the user's turn; the sidecar bearer token must never reach a subprocess.
 *  Used for the CLI process AND the MCP Bash tool's children, so shell
 *  commands can't see what the model can't. */
export function sanitizedEnv() {
  const env = { ...process.env };
  // CLAUDE_CODE_USE_* selects third-party providers (Bedrock/Vertex/Foundry/
  // …) — any of them would route/bill the "subscription" turn through those
  // credentials instead of the CLI's login. Strip the whole family, present
  // and future, alongside direct Anthropic keys.
  for (const key of Object.keys(env)) {
    if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_USE_')) delete env[key];
  }
  // The SDK honors this as auth too — a stray token from the launching shell
  // would route the turn through the wrong account.
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.SUNDIAL_LOCAL_TOKEN;
  // Auto-memory loads regardless of `settingSources: []` — without this the
  // user's personal Claude Code memory (~/.claude/projects/**/memory) leaks
  // into (and gets written by) Sundial chats.
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return env;
}

/** The env the CLI itself is spawned with. A Finder-launched app inherits
 *  launchd's minimal PATH — no nvm, no homebrew — but an
 *  `npm i -g @anthropic-ai/claude-code` install is a `#!/usr/bin/env node`
 *  shim: detection's nvm probe FINDS it and the exec then dies 127 "env: node:
 *  No such file or directory". The shim's own directory holds the node that
 *  runs it (same fix as codex-runner). */
export function engineEnv(enginePath) {
  const env = sanitizedEnv();
  if (enginePath) env.PATH = `${path.dirname(enginePath)}${path.delimiter}${env.PATH ?? ''}`;
  return env;
}

/** One turn on the user's Claude. `queryFn` (tests) replaces the SDK: it gets
 *  `{ prompt, options, tools }` and yields SDK-shaped messages. */
export async function runClaudeTurn({
  project, chatId, model, editMode, tools, stream, abort, store, log, isReplaced, settleWatcher, assistantMessageId, external = null, queryFn = null,
  untrustedCommentTurn = false, historyRows = null,
}) {
  // Offline e2e seam: tests script the SDK by pointing this env at a module
  // exporting `queryFn` — the whole HTTP surface runs real, nothing spawns.
  if (!queryFn && process.env.SUNDIAL_CLAUDE_QUERY_MODULE) {
    queryFn = (await import(process.env.SUNDIAL_CLAUDE_QUERY_MODULE)).queryFn;
  }
  const engine = detectClaudeEngine();
  let sdk = null;
  if (!queryFn) {
    if (!engine.available) {
      throw new Error('Claude Code isn\'t installed on this machine. Install it and run `claude login`, then pick Claude Code again.');
    }
    sdk = await loadSdk();
  }

  // Adopted external session: resume the CLI's own session file (its recorded
  // cwd — often a subfolder — is where resume-by-id resolves) and send only
  // the rows the engine hasn't seen. A vanished session file falls back to
  // the full-history rebuild; the imported rows cover the context.
  // Both the session FILE and the recorded cwd must still exist — the SDK
  // subprocess launches from that cwd, and a deleted subfolder would fail the
  // turn instead of falling back.
  let resume = null;
  // Never resume a native session for a guest turn — the CLI's own session
  // file carries the full prior context the sanitized historyRows exclude.
  if (!untrustedCommentTurn && external?.agent === 'claude' && external.cwd && fs.existsSync(external.cwd)) {
    const { claudeSessionFileExists } = await import('../external-sessions.mjs');
    if (claudeSessionFileExists(external.cwd, external.sessionId)) resume = { cwd: external.cwd };
  }
  const rows = historyRows ?? store.listChatMessages(project.id, chatId);
  const messages = rowsToModelMessages(resume ? rowsUnseenByEngine(rows) : rows);
  const prompt = modelMessagesToClaudePrompt(messages);
  const system =
    systemPrompt(project, store.listExtraRoots(project.id), {
      folderScope: store.getChat(chatId)?.folder_scope || null,
      untrustedComment: untrustedCommentTurn,
    }) +
    (editMode === 'view'
      ? '\n\nThe user has this document in VIEWING mode: you are READ-ONLY this turn. Do not attempt writes.'
      : '');

  // Bridge the run's AbortSignal into the SDK's AbortController.
  const ac = new AbortController();
  if (abort.signal.aborted) ac.abort(abort.signal.reason);
  else abort.signal.addEventListener('abort', () => ac.abort(abort.signal.reason), { once: true });

  const toolNames = Object.keys(tools).map((name) => `${MCP_PREFIX}${name}`);
  // Bare names the preset trains the model on → our MCP tools (so the CLI's
  // native Read/Edit/Bash never run and every write stays attributed).
  const toolAliases = { web_search: 'WebSearch', web_fetch: 'WebFetch' };
  for (const full of toolNames) toolAliases[stripPrefix(full)] = full;

  const env = engineEnv(engine.path);
  // Without this callback the SDK pipes the CLI's stderr to /dev/null, so a
  // startup failure reaches us as a bare "process exited with code 1" and the
  // real reason (not onboarded, bad model, missing runtime) is lost.
  let stderrTail = '';
  const withStderr = (message) =>
    [message, stderrTail.trim()].filter(Boolean).join(': ').slice(0, 500) ||
    (queryFn ? NO_OUTPUT : diagnoseSilence(engine.path, env));

  const options = {
    stderr: (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-2000);
    },
    // anthropic/claude-sonnet-4.6 → claude-sonnet-4-6; other providers fall
    // through to the CLI's default model.
    ...(model?.startsWith('anthropic/') ? { model: model.slice('anthropic/'.length).replace(/\./g, '-') } : {}),
    cwd: resume ? resume.cwd : project.root,
    ...(resume ? { resume: external.sessionId } : {}),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: system },
    ...(sdk ? { mcpServers: { sundial: buildMcpServer(sdk, tools) } } : {}),
    // ONLY our MCP server: the user's own MCP servers/plugins would otherwise
    // load alongside it and run un-prompted (bypassPermissions), outside the
    // DocHost attribution rails — and straight through view mode.
    strictMcpConfig: true,
    // Untrusted (guest-comment) turns also lose the network tools — a guest
    // prompt could exfiltrate file contents through a WebFetch URL.
    allowedTools: [...toolNames, ...(untrustedCommentTurn ? [] : ['WebSearch', 'WebFetch']), 'TodoWrite'],
    // Native fs/exec tools are REMOVED from the model's context in every
    // mode, not just alias-shadowed: aliases are built from the (edit-mode
    // filtered) Sundial toolset, so in view mode a bare `Edit`/`Bash` would
    // otherwise resolve to the live native tool and mutate disk outside the
    // attributed DocHost path. `tools` sets the built-in base set; the
    // explicit `disallowedTools` list covers CLIs too old to know `tools`.
    tools: [...(untrustedCommentTurn ? [] : ['WebSearch', 'WebFetch']), 'TodoWrite'],
    disallowedTools: [
      'Task', 'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
      'Glob', 'Grep', 'BashOutput', 'KillShell',
    ],
    toolAliases,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    // No maxTurns: runs are uncapped — only interrupt/finish end a turn.
    abortController: ac,
    settingSources: [],
    env,
    ...(engine.path ? { pathToClaudeCodeExecutable: engine.path } : {}),
  };

  stream.write({ type: 'start', messageId: assistantMessageId });

  let seq = 0;
  let openText = null;
  let openReasoning = null;
  let reasoningText = ''; // deltas since reasoning-start, persisted on close
  let persistedReasoning = false; // a thinking row exists, so the turn needs its anchor
  // Survives a flush, unlike segmentText. Anything the model actually said
  // means the turn produced output — needed both to keep it anchored and to
  // keep it out of the "the CLI returned nothing" diagnosis.
  let sawText = false;
  let segmentText = ''; // streamed text since the last tool call
  let ranTools = false;
  let finalText = '';
  let resultError = null;
  let continuedSessionId = null; // resume forks: the id the NEXT turn resumes
  const toolNameById = new Map();
  const toolByIndex = new Map(); // content_block index → tool_use id, while its input streams

  const closeText = () => {
    if (openText) stream.write({ type: 'text-end', id: openText });
    openText = null;
  };
  const closeReasoning = () => {
    if (openReasoning) stream.write({ type: 'reasoning-end', id: openReasoning });
    // Persist the thought as its own row, in stream order, like the cloud-step
    // loop does. Streaming it alone meant any reconnect + history reconcile
    // wiped the reasoning and left a bare "Thinking…".
    if (!isReplaced() && appendThinkingRow(store, project.id, chatId, reasoningText)) persistedReasoning = true;
    reasoningText = '';
    openReasoning = null;
  };
  // Text announced BEFORE a tool call persists as its own row so a reload
  // renders the turn in stream order (same rule as the cloud-step loop).
  // `streaming: true` marks it IN-FLIGHT (same marker the cloud-step loop and
  // the brain use): only the final anchor row is unmarked, and that asymmetry
  // is what tells reload / gone-recovery the turn actually ended.
  const flushSegment = () => {
    if (segmentText.trim()) {
      store.appendChatMessage(project.id, chatId, {
        role: 'assistant',
        content: segmentText,
        metadata: { streaming: true },
      });
    }
    segmentText = '';
  };

  const onMessage = (msg) => {
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
          continuedSessionId = msg.session_id;
          // The CLI is writing a transcript for this turn under ~/.claude.
          // Claim it NOW (not at turn end): an interrupted or crashed turn
          // still leaves the file behind, and an unclaimed file comes back
          // as an "external session" the user is invited to import — the
          // duplicate-chat bug. Unresumed turns open a session per turn, so
          // every id gets claimed, not just the last.
          store.recordEngineSession('claude', msg.session_id, chatId);
        }
        break;
      }
      case 'stream_event': {
        const ev = msg.event;
        // Tool inputs stream too: a long Write (hundreds of lines) is minutes
        // of generation the user would otherwise watch as a blank bubble.
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          const { id, name } = ev.content_block;
          closeText();
          // Segment BEFORE reasoning, and HERE: with includePartialMessages the
          // SDK emits this block start ahead of the assembled assistant
          // message, so this is the handler that actually decides row order on
          // a text -> thinking -> tool turn. The announcement was spoken first,
          // so its row has to land first. (thinking -> text already persisted
          // its thought at the text delta, so closeReasoning is a no-op there.)
          // Flushing here clears segmentText while `ranTools` is still false,
          // which would open an anchor-loss window for a Stop during tool-input
          // streaming — `sawText` is what keeps that turn anchored.
          flushSegment();
          closeReasoning();
          toolByIndex.set(ev.index, id);
          stream.write({ type: 'tool-input-start', toolCallId: id, toolName: stripPrefix(name) });
          break;
        }
        if (ev.type !== 'content_block_delta') break;
        const d = ev.delta;
        if (d.type === 'input_json_delta' && d.partial_json && toolByIndex.has(ev.index)) {
          stream.write({ type: 'tool-input-delta', toolCallId: toolByIndex.get(ev.index), inputTextDelta: d.partial_json });
        } else if (d.type === 'text_delta' && d.text) {
          closeReasoning();
          if (!openText) {
            openText = `t${seq++}`;
            stream.write({ type: 'text-start', id: openText });
          }
          segmentText += d.text;
          if (d.text.trim()) sawText = true;
          stream.write({ type: 'text-delta', id: openText, delta: d.text });
        } else if (d.type === 'thinking_delta' && d.thinking) {
          closeText();
          if (!openReasoning) {
            openReasoning = `r${seq++}`;
            stream.write({ type: 'reasoning-start', id: openReasoning });
          }
          reasoningText += d.thinking;
          stream.write({ type: 'reasoning-delta', id: openReasoning, delta: d.thinking });
        }
        break;
      }
      case 'assistant': {
        for (const block of msg.message?.content ?? []) {
          if (block.type !== 'tool_use') continue;
          const name = stripPrefix(block.name);
          closeText();
          // Segment BEFORE reasoning: on a text → thinking → tool sequence the
          // announcement was spoken first, so its row has to land first.
          // (thinking → text already persisted its thought at the text delta,
          // so closeReasoning is a no-op there and the order still holds.)
          flushSegment();
          closeReasoning();
          ranTools = true;
          toolNameById.set(block.id, name);
          store.appendChatMessage(project.id, chatId, {
            role: 'system',
            content: '',
            metadata: { type: 'tool_use', tool_use_id: block.id, tool: { name, input: block.input ?? {} } },
          });
          // Already opened by the streamed content_block_start (partial
          // messages on); a CLI without them opens it here.
          if (![...toolByIndex.values()].includes(block.id)) {
            stream.write({ type: 'tool-input-start', toolCallId: block.id, toolName: name });
          }
          stream.write({ type: 'tool-input-available', toolCallId: block.id, toolName: name, input: block.input ?? {} });
        }
        break;
      }
      case 'user': {
        const content = msg.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (!block || block.type !== 'tool_result') continue;
          const text = toolResultText(block.content);
          const isError = block.is_error === true;
          log?.(`local-claude tool=${toolNameById.get(block.tool_use_id) ?? 'tool'} error=${isError} chat=${chatId}`);
          store.appendChatMessage(project.id, chatId, {
            role: 'system',
            content: text,
            metadata: {
              type: 'tool_result',
              tool_use_id: block.tool_use_id,
              tool_name: toolNameById.get(block.tool_use_id) ?? 'tool',
              is_error: isError,
            },
          });
          stream.write(
            isError
              ? { type: 'tool-output-error', toolCallId: block.tool_use_id, errorText: text }
              : { type: 'tool-output-available', toolCallId: block.tool_use_id, output: text },
          );
        }
        break;
      }
      case 'result': {
        if (msg.subtype === 'success') finalText = typeof msg.result === 'string' ? msg.result : '';
        else resultError = typeof msg.result === 'string' ? msg.result : msg.subtype;
        break;
      }
      default:
        break;
    }
  };

  try {
    const source = queryFn ? queryFn({ prompt, options, tools }) : sdk.query({ prompt, options });
    for await (const msg of source) onMessage(msg);
  } catch (error) {
    // A user Stop aborts the SDK subprocess — clean end of turn, not a
    // failure. Persist what streamed, unless this run was cancel-and-REPLACED
    // (the new send's user row is already appended; persisting after it would
    // corrupt transcript order).
    if (abort.signal.aborted) {
      if (isReplaced()) return;
    } else if (!resultError && !segmentText.trim() && !ranTools) {
      // Nothing streamed and no verdict — fail the turn outright.
      throw friendlyClaudeError(new Error(withStderr(error?.message)));
    } else if (!resultError) {
      // Real work streamed, then the subprocess died without a terminal
      // result — persist the partial turn as FAILED below, don't lose it.
      resultError = friendlyClaudeError(error).message;
    }
    // With resultError already captured, the terminal result decided the
    // turn; a late throw during teardown must not skip persistence.
  }
  closeText();
  closeReasoning();
  if (isReplaced()) return;
  // Resuming forks the engine session to a NEW id — persist it so the next
  // turn continues from this one instead of replaying the pre-fork session.
  if (resume && continuedSessionId && continuedSessionId !== external.sessionId) {
    store.updateChat(chatId, { external_resume_id: continuedSessionId });
  }

  // The CLI reports failures (not-logged-in, error_max_turns,
  // error_during_execution) as a RESULT message, not a thrown error — and a
  // CLI that never got going emits no result at ALL and exits 0. Either way,
  // with nothing streamed that's the whole turn: fail it rather than finish
  // clean on an empty transcript, which reads as the agent ignoring you.
  // `sawText`, not segmentText alone: a segment FLUSHED at a tool block start
  // is still output the model produced, and judging by the cleared buffer
  // would report "the CLI returned nothing" about a turn that spoke.
  const nothingStreamed = !ranTools && !segmentText.trim() && !sawText;
  if (nothingStreamed && (resultError || LOGIN_ERROR.test(finalText) || (!finalText.trim() && !abort.signal.aborted))) {
    throw friendlyClaudeError(new Error(withStderr(resultError || finalText)));
  }

  // Deltas are the source of truth; `result` covers a turn whose stream
  // events never arrived. Text that never streamed still reaches the UI.
  let text = segmentText;
  if (!text.trim() && finalText.trim() && !abort.signal.aborted) {
    const id = `t${seq++}`;
    stream.write({ type: 'text-start', id });
    stream.write({ type: 'text-delta', id, delta: finalText });
    stream.write({ type: 'text-end', id });
    text = finalText;
  }
  // Same anchor rule as the cloud loop: a tool turn always persists the final
  // assistant row (even empty) under assistantMessageId so reload/reconnect
  // recovery can't duplicate the streamed message.
  // A terminal error AFTER partial output (e.g. error_max_turns mid-edit):
  // the work is real and persists, but the turn must not read as a clean
  // completion — run_status:'error' makes reload's latestTurnOutcome call it
  // 'failed', and the live stream gets an error instead of 'finish'.
  const editsMeta = turnEditsMetadata(store, project.id, assistantMessageId);
  // `persistedReasoning` counts: this engine now writes thinking rows, and a
  // Stop during thinking would otherwise leave them with NO anchor — flushed
  // under a synthetic id, read as outcome 'none', and retried by the client
  // for minutes.
  // `sawText` closes the gap the block-start flush opens: between it and the
  // assembled assistant frame, text/ranTools/persistedReasoning/resultError can
  // ALL be falsy, and a Stop there would persist no anchor at all.
  if (text.trim() || ranTools || resultError || persistedReasoning || sawText) {
    // A contentless anchor needs a terminal marker or latestTurnOutcome reads
    // the turn as unfinished. Neither value counts as a failure.
    const terminal =
      !text.trim() && !ranTools && !resultError
        ? { run_status: abort?.signal?.aborted ? 'aborted' : 'completed' }
        : {};
    store.appendChatMessage(project.id, chatId, {
      id: assistantMessageId,
      role: 'assistant',
      content: text,
      metadata: resultError
        ? { ...editsMeta, run_status: 'error', run_error: `Claude stopped before finishing (${resultError}).` }
        : { ...editsMeta, ...terminal },
    });
  }
  // A turn that died mid-edit still edited — stamp before the error frame.
  writeTurnEditsMetadata(stream, editsMeta);
  // AFTER the append: the top-up MERGES into the persisted row, so running it
  // first would be a no-op and reload would read the stale empty count. Bash
  // writes land through the watcher's debounce, which can be after the count
  // above (see runner.mjs).
  await topUpTurnEdits({ store, projectId: project.id, assistantMessageId, editsMeta, stream, settleWatcher, ranTools });
  if (resultError) {
    stream.write({ type: 'error', errorText: `Claude stopped before finishing (${resultError}).` });
    return;
  }
  stream.write({ type: 'finish', finishReason: 'stop' });
}
