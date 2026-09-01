import type { editor, languages, IDisposable, IRange, Position, CancellationToken } from 'monaco-editor';
import {
  MAX_PREFIX_LINES,
  MAX_SUFFIX_LINES,
  cacheKey,
  clampPrefix,
  clampSuffix,
  createCompletionCache,
  isLatexTriggerContext,
  type CompletionCache,
} from './engine';
import { __resetAutocompleteFlagForTest, isAutocompleteEnabled, setAutocompleteEnabled } from './flag';
import { deterministicCompletion } from './deterministic';
import { getAutocompleteMode, type AutocompleteMode } from './mode';
import { __resetAutocompleteActivityForTest, setAutocompleteActivity } from './status';
import { __resetAutocompleteModeForTest } from './mode';
import { track } from '@/lib/analytics/track';

/**
 * Monaco adapter for ghost-text autocomplete — the thin glue between the pure
 * engine and Monaco's inline-completions channel, mirroring the
 * `latex-completions.ts` / `monaco-latex-completion.ts` split.
 *
 * Ghost text is decoration-only: nothing touches the Y.Text until Tab, and an
 * accept is a normal Monaco edit flowing through the existing y-binding. Zero
 * new CRDT surface.
 *
 * Coexistence with the LaTeX suggest widget (`registerCompletionItemProvider`)
 * is by channel, not by coordination: the widget owns Tab whenever it is open,
 * and this provider declines to fire inside a LaTeX trigger context so the
 * deterministic refs/cites/paths always win where they have something to say.
 */

/** Pilot scope: prose surfaces only, not general code files or notebooks. */
const SUPPORTED_LANGUAGES = new Set(['markdown', 'latex']);

/** For surfaces that explain the scope (the editor's status chip). */
export function isAutocompleteSupportedLanguage(language: string): boolean {
  return SUPPORTED_LANGUAGES.has(language);
}

const DEBOUNCE_MS = 300;
const ENDPOINT = '/api/workspace/autocomplete';
/** Runs when a ghost text is accepted (Tab) — the reliable acceptance signal:
 *  Monaco executes an inline completion item's `command` on accept. */
export const ACCEPT_COMMAND_ID = 'sundial.autocomplete.accepted';

/* ── Per-editor context ───────────────────────────────────────── */

/** The slice of `fetch` the completion request needs. */
export type AutocompleteFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export type AutocompleteEditorContext = {
  projectId: string;
  filePath: string;
  /** Monaco language id, as `getCodeLanguage(filePath)` resolves it. */
  language: string;
  readOnly: boolean;
  /** The page's workspace fetch (the sidecar shim on local workspaces).
   *  Typed to the three things this module actually reads, so a test stub is
   *  a plain object literal rather than a double cast through `unknown`; a
   *  real `typeof fetch` satisfies it. */
  fetchImpl?: AutocompleteFetch;
};

// Keyed by model, not module-level: split panes mount two editors on two
// files, and a single shared context would answer for the wrong one.
const contexts = new WeakMap<editor.ITextModel, AutocompleteEditorContext>();

export function setAutocompleteContext(
  model: editor.ITextModel,
  context: AutocompleteEditorContext,
): void {
  contexts.set(model, context);
}

export function clearAutocompleteContext(model: editor.ITextModel): void {
  contexts.delete(model);
}

/* ── Provider ─────────────────────────────────────────────────── */

export type InlineCompletionDeps = {
  /** Injected in tests so the debounce runs on fake timers. */
  delay?: (ms: number) => Promise<void>;
  debounceMs?: number;
  cache?: CompletionCache;
  /** One clock per provider, for the debounce deadline and the backoff. */
  now?: () => number;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The debounce is a deadline, not a sleep. Everything done before the wait —
 *  gating, window slicing, the cache probe, and anything async that lands in
 *  front of it later (the credit gate is the one on deck) — spends the same
 *  budget, so slow prep costs the typist no extra latency instead of stacking
 *  on top of the 300ms. Copilot's language server does exactly this: it builds
 *  the whole prompt first, then waits `max(0, debounce - (now - issuedTime))`.
 *
 *  Clamped at BOTH ends: `Date.now()` is wall clock, and a backwards NTP step
 *  mid-wait would otherwise stretch the pause past the budget. */
export function remainingDebounceMs(budgetMs: number, issuedAt: number, nowMs: number): number {
  const spent = nowMs - issuedAt;
  if (!Number.isFinite(spent) || spent <= 0) return budgetMs;
  return Math.max(0, budgetMs - spent);
}

function inlineCompletions(
  text: string,
  position: Position,
  meta: { mode: AutocompleteMode; language: string; source: 'network' | 'cache' | 'deterministic' },
): languages.InlineCompletions {
  const range: IRange = {
    startLineNumber: position.lineNumber,
    startColumn: position.column,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  };
  return {
    items: [
      {
        insertText: text,
        range,
        // Fires on accept — acceptance-rate telemetry with zero polling.
        command: { id: ACCEPT_COMMAND_ID, title: '', arguments: [meta] },
      },
    ],
    // Typing characters that match the ghost text keeps the same suggestion
    // instead of re-requesting — the "keep typing to invalidate" behaviour.
    enableForwardStability: true,
  };
}

/** `served: false` is a transport/server failure, NOT an answer. The
 *  difference matters: a 429 from the route's bucket cached as "no completion"
 *  would silently kill autocomplete at that cursor forever.
 *
 *  `backoff` is the other half of that: not caching a 429 means the next
 *  keystroke asks again, and each refusal still costs a full auth + workspace
 *  lookup server-side before the bucket says no. A refusal that will keep
 *  refusing has to stop the asking.
 *
 *  `grant` rides along on any response whose request paid the route's full
 *  auth + access check: a signed pass for this workspace+file that later
 *  requests echo back so the route can skip that check. Opaque here — expiry
 *  is the route's problem, and a stale grant just falls back to the full
 *  check, whose response carries the replacement. */
type CompletionResult =
  | { served: true; completion: string | null; grant?: string }
  | { served: false; backoff: boolean; grant?: string };

/** "Stop asking for a while", not "nothing to suggest here": the bucket is
 *  empty, the session expired, the workspace/file is gone, the payer is out of
 *  credits. 402 belongs here for the same reason 429 does — without it a
 *  refused payer re-asks on every keystroke, and each of those pays for a full
 *  auth, access check and balance read, because a refusal mints no grant. */
const BACKOFF_STATUSES = new Set([401, 402, 403, 404, 429]);
const BACKOFF_MS = 30_000;

async function fetchCompletion(
  context: AutocompleteEditorContext,
  window: { prefix: string; suffix: string },
  signal: AbortSignal,
  grant: string | undefined,
): Promise<CompletionResult> {
  const doFetch = context.fetchImpl ?? fetch;
  const response = await doFetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: context.projectId,
      filePath: context.filePath,
      language: context.language,
      prefix: window.prefix,
      suffix: window.suffix,
      ...(grant ? { grant } : {}),
    }),
    signal,
  });
  if (!response.ok) return { served: false, backoff: BACKOFF_STATUSES.has(response.status) };
  const data = (await response.json()) as { completion?: unknown; served?: unknown; grant?: unknown };
  const renewed = typeof data?.grant === 'string' && data.grant ? data.grant : undefined;
  // The route answers 200 on a gateway failure (autocomplete never toasts)
  // and flags it — without the flag a provider blip would cache as an answer.
  if (data?.served === false) return { served: false, backoff: false, grant: renewed };
  return {
    served: true,
    completion: typeof data?.completion === 'string' && data.completion ? data.completion : null,
    grant: renewed,
  };
}

export function createInlineCompletionProvider(
  deps: InlineCompletionDeps = {},
): languages.InlineCompletionsProvider {
  const delay = deps.delay ?? sleep;
  const now = deps.now ?? (() => Date.now());
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
  const cache = deps.cache ?? createCompletionCache();
  // Signed access grants by workspace+file, verbatim from route responses.
  // Keyed like the LRU (not per-model): split panes on one file share the
  // grant, and the provider outlives in-app navigation. The cap only guards
  // a pathological session — entries are a few hundred bytes each.
  //
  // No invalidation channel: a grant carries the user's autocomplete model,
  // signed at mint time, and the route's minute-long TTL is what retires a
  // stale one. Reaching in from the preferences panel to clear this map
  // bought instant model switching at the price of a cross-module global.
  //
  // The LRU above carries the other half of that promise: its entries expire
  // on the same minute (`DEFAULT_CACHE_TTL_MS`), because a grant TTL only
  // governs the next REQUEST — a cached cursor would keep serving the old
  // model's text without ever making one.
  const grants = new Map<string, string>();
  const MAX_GRANTS = 256;
  // One in-flight request per editor: the next keystroke cancels the last.
  const inflight = new WeakMap<editor.ITextModel, AbortController>();
  // Set by a refusal that will keep refusing (empty bucket, expired session).
  const backoffUntil = new WeakMap<editor.ITextModel, number>();

  return {
    // We own the debounce below; Monaco must not stack a second one on top.
    debounceDelayMs: 0,
    async provideInlineCompletions(
      model: editor.ITextModel,
      position: Position,
      _context: languages.InlineCompletionContext,
      token: CancellationToken,
    ): Promise<languages.InlineCompletions | undefined> {
      // The debounce budget starts HERE, not at the `delay` below.
      const issuedAt = now();
      const context = contexts.get(model);
      if (!context || context.readOnly || !context.projectId) return undefined;
      if (!SUPPORTED_LANGUAGES.has(context.language)) return undefined;
      if (!isAutocompleteEnabled()) return undefined;
      // Checked before anything else: a rate-limited editor must go quiet, not
      // keep spending a server-side auth + workspace lookup per keystroke to
      // be refused again.
      if ((backoffUntil.get(model) ?? 0) > issuedAt) return undefined;

      const linePrefix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      // The LaTeX suggest widget owns Tab here — never race it with ghost text.
      if (context.language === 'latex' && isLatexTriggerContext(linePrefix)) return undefined;

      // Bounded reads: a whole-document getValue() on every keystroke is the
      // one thing that would make typing in a long paper feel worse, not better.
      const firstLine = Math.max(1, position.lineNumber - MAX_PREFIX_LINES);
      const lastLine = Math.min(model.getLineCount(), position.lineNumber + MAX_SUFFIX_LINES);
      const prefix = clampPrefix(
        model.getValueInRange({
          startLineNumber: firstLine,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        }),
      );
      const suffix = clampSuffix(
        model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: lastLine,
          endColumn: model.getLineMaxColumn(lastLine),
        }),
      );
      if (!prefix.trim()) return undefined;

      // Deterministic mode never leaves the client: document-term and syntax
      // completion, synchronous, free — no debounce, no cache, no grant.
      const mode = getAutocompleteMode();
      if (mode === 'deterministic') {
        const local = deterministicCompletion({ prefix, suffix, language: context.language });
        return local
          ? inlineCompletions(local, position, { mode, language: context.language, source: 'deterministic' })
          : undefined;
      }

      // Scoped by workspace AND path: the provider outlives an in-app
      // navigation, so `notes/intro.md` in two workspaces is two documents.
      const docKey = `${context.projectId}␟${context.filePath}`;
      const key = cacheKey(prefix, suffix, context.language, docKey);
      const cached = cache.get(key);
      if (cached !== undefined) {
        return cached
          ? inlineCompletions(cached, position, { mode, language: context.language, source: 'cache' })
          : undefined;
      }

      // Captured with the window above, not after the debounce: a remote
      // collaborator's CRDT edit landing DURING the 300ms wait would otherwise
      // pass the guard, and the completion would be computed from stale text
      // and anchored at a `position` the remote insert has already shifted.
      const versionId = model.getVersionId();
      inflight.get(model)?.abort();
      const controller = new AbortController();
      inflight.set(model, controller);
      const cancellation = token.onCancellationRequested(() => controller.abort());
      try {
        const remaining = remainingDebounceMs(debounceMs, issuedAt, now());
        if (remaining > 0) await delay(remaining);
        if (token.isCancellationRequested || controller.signal.aborted) return undefined;
        if (model.getVersionId() !== versionId) return undefined;
        setAutocompleteActivity('pending');
        const result = await fetchCompletion(context, { prefix, suffix }, controller.signal, grants.get(docKey));
        // Stored BEFORE the staleness guards: the grant is about the file,
        // not this cursor — a response that lost the version race still
        // carries a pass the next keystroke should ride.
        if (result.grant) {
          if (grants.size >= MAX_GRANTS) grants.clear();
          grants.set(docKey, result.grant);
        }
        if (token.isCancellationRequested || controller.signal.aborted) return undefined;
        if (model.getVersionId() !== versionId) return undefined;
        // Only a served answer is cached: memoizing a 429/500 as "no
        // completion" would silence this cursor for the rest of the session.
        if (!result.served) {
          if (result.backoff) backoffUntil.set(model, now() + BACKOFF_MS);
          track('autocomplete_completion', {
            language: context.language,
            latency_ms: now() - issuedAt,
            outcome: result.backoff ? 'backoff' : 'unserved',
          });
          return undefined;
        }
        cache.set(key, result.completion);
        track('autocomplete_completion', {
          language: context.language,
          latency_ms: now() - issuedAt,
          outcome: result.completion ? 'shown' : 'empty',
        });
        if (result.completion) {
          return inlineCompletions(result.completion, position, {
            mode,
            language: context.language,
            source: 'network',
          });
        }
        // The model came back empty (it happens — 3-token answers that post-
        // processing strips). Fall back to the deterministic engine so the
        // pause still buys the typist something when the document has it.
        const local = deterministicCompletion({ prefix, suffix, language: context.language });
        return local
          ? inlineCompletions(local, position, { mode, language: context.language, source: 'deterministic' })
          : undefined;
      } catch {
        // Autocomplete fails silent, always: an aborted fetch, an offline
        // window, and a 500 all mean "no ghost text", never a toast.
        if (!controller.signal.aborted && !token.isCancellationRequested) {
          track('autocomplete_completion', {
            language: context.language,
            latency_ms: now() - issuedAt,
            outcome: 'error',
          });
        }
        return undefined;
      } finally {
        cancellation?.dispose?.();
        if (inflight.get(model) === controller) {
          inflight.delete(model);
          // Ours is the newest request — a superseding keystroke owns the
          // chip otherwise, and will set 'pending' itself.
          setAutocompleteActivity('idle');
        }
      }
    },
    disposeInlineCompletions() {},
  };
}

/* ── Register-once wiring ─────────────────────────────────────── */

let registered = false;

/** Registered once per page, like `registerLatexCompletions` — the provider
 *  reads whatever context the mounted editors last set for their model. */
export function registerAutocompleteProvider(
  monaco: typeof import('monaco-editor'),
  deps?: InlineCompletionDeps,
): void {
  if (registered) return;
  registered = true;
  monaco.languages.registerInlineCompletionsProvider('*', createInlineCompletionProvider(deps));
  // Global (not per-editor): a Monaco command id resolves app-wide, and every
  // completion item this provider serves names this one.
  monaco.editor.registerCommand(ACCEPT_COMMAND_ID, (_accessor: unknown, meta: unknown) => {
    track('autocomplete_accepted', (meta ?? {}) as Record<string, unknown>);
  });
}

/** Right-click toggle, in the surface the feature lives in — no prop
 *  plumbing, and it reaches every editor that mounts the code surface.
 *
 *  The call site registers this when the pilot flag is on AT MOUNT, so an
 *  editor that shows the entry keeps it for that editor's whole life — off
 *  and back on. Re-gating the entry on the live flag would make it a one-way
 *  door: turn ghost text off and the entry that turns it back on is the one
 *  that just disappeared, leaving `?autocomplete=on` as the only way home.
 *
 *  A Monaco action label is fixed at registration, so this one names the
 *  verb rather than the direction — "Disable…" would be a lie one click
 *  later, and stale menu text is worse than a neutral one. */
export function registerAutocompleteToggleAction(
  editorInstance: editor.IStandaloneCodeEditor,
): IDisposable {
  return editorInstance.addAction({
    id: 'sundial.toggleAiAutocomplete',
    label: 'Toggle AI autocomplete',
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 2,
    run: () => {
      setAutocompleteEnabled(!isAutocompleteEnabled());
    },
  });
}

/** Test-only: reset module state between cases. */
export function __resetAutocompleteForTest(): void {
  registered = false;
  __resetAutocompleteFlagForTest();
  __resetAutocompleteModeForTest();
  __resetAutocompleteActivityForTest();
}
