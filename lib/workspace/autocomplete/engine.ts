/**
 * The non-model half of ghost-text autocomplete: context slicing, completion
 * post-processing, and the client-side LRU. Most of the perceived quality
 * lives here — a raw model completion routinely arrives fenced, echoing the
 * line the cursor sits on, or re-closing a bracket the suffix already closes.
 *
 * Pure and dependency-free on purpose (same contract as `prompt.ts`): an
 * out-of-tree prompt notebook imports this file directly under a Deno
 * kernel, so nothing here may import from `@/…`, from Next, or from
 * `lib/workspace/ai-gateway.ts` — pinned by `autocomplete-purity.test.ts`.
 */

import { INSERTION_ANCHOR } from './prompt';

/* ── Context window ───────────────────────────────────────────── */

export const MAX_PREFIX_LINES = 50;
export const MAX_PREFIX_CHARS = 2000;
export const MAX_SUFFIX_LINES = 20;
export const MAX_SUFFIX_CHARS = 1000;
export const MAX_COMPLETION_LINES = 5;

/** Last ~50 lines / 2,000 chars before the cursor (whichever bites first). */
export function clampPrefix(text: string): string {
  const byChars = text.length > MAX_PREFIX_CHARS ? text.slice(-MAX_PREFIX_CHARS) : text;
  const lines = byChars.split('\n');
  return lines.length > MAX_PREFIX_LINES ? lines.slice(-MAX_PREFIX_LINES).join('\n') : byChars;
}

/**
 * Next ~20 lines / 1,000 chars after the cursor, never ending mid-word.
 *
 * The half-word a raw character cut leaves behind is the LAST thing in the
 * prompt, and the model completes that instead of the cursor: with the window
 * ending `…and it do`, Haiku answers `es so without sacrificing…` and signs
 * off with `\end{document}`, having decided it was finishing the document. It
 * reproduces on both arms of the prompt notebook (Codestral returns the same
 * `equired.` as Haiku) and on every cursor whose suffix hits the cap, which in
 * a real paper is most of them. Dropping the partial word costs a few
 * characters of context and removes the bait. The line clamp below needs no
 * such repair — it already cuts at a newline. A word that fills the cap on its
 * own (minified line, base64 blob) has no boundary to retreat to, so it stays.
 */
export function clampSuffix(text: string): string {
  let byChars = text;
  if (text.length > MAX_SUFFIX_CHARS) {
    const hard = text.slice(0, MAX_SUFFIX_CHARS);
    byChars = hard.replace(/\S+$/, '') || hard;
  }
  const lines = byChars.split('\n');
  return lines.length > MAX_SUFFIX_LINES ? lines.slice(0, MAX_SUFFIX_LINES).join('\n') : byChars;
}

export type CompletionContext = { prefix: string; suffix: string; language?: string };

/** Split a document at a 0-based character offset into a clamped FIM window. */
export function sliceContext(text: string, offset: number): CompletionContext {
  const at = Math.max(0, Math.min(offset, text.length));
  return { prefix: clampPrefix(text.slice(0, at)), suffix: clampSuffix(text.slice(at)) };
}

/* ── Post-processing ──────────────────────────────────────────── */

/** Overlap this long is the model re-emitting the suffix, whatever it is. */
const MIN_TEXT_OVERLAP = 8;

/** Shorter overlaps are only trimmed when they are pure "closing" text —
 *  the brackets / `\end{…}` the document already carries after the cursor. */
const CLOSING_RUN = /^(?:\s|[)\]}>$'"`;,]|\\end\{[^}]*\})+$/;

/** A completion this short can legitimately echo the prefix (`)`, `;`). */
const MIN_REPETITION_LENGTH = 3;

/** Models wrap completions in ``` despite being told not to. */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return text;
  const firstNewline = trimmed.indexOf('\n');
  const body = firstNewline === -1 ? '' : trimmed.slice(firstNewline + 1);
  const closing = body.lastIndexOf('```');
  return (closing === -1 ? body : body.slice(0, closing)).replace(/\n$/, '');
}

/** Drop a re-emission of the text the cursor already sits after: the whole
 *  current line first, then the partial word (mid-word cursor: `func` +
 *  `function foo()` → `tion foo()`). */
function stripPrefixEcho(completion: string, prefix: string): string {
  const currentLine = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (currentLine && completion.startsWith(currentLine)) return completion.slice(currentLine.length);
  const word = /[\p{L}\p{N}_\\]+$/u.exec(currentLine)?.[0];
  if (word && completion.startsWith(word)) return completion.slice(word.length);
  return completion;
}

/** True when the completion is just the tail of the prefix said again. */
function repeatsPrefix(completion: string, prefix: string): boolean {
  const trimmed = completion.trim();
  if (trimmed.length < MIN_REPETITION_LENGTH) return false;
  return prefix.trimEnd().endsWith(trimmed);
}

/** Trim the tail the suffix already provides (`)`, `}`, `\end{itemize}`). */
function trimSuffixOverlap(completion: string, suffix: string): string {
  const max = Math.min(completion.length, suffix.length);
  for (let k = max; k > 0; k -= 1) {
    const overlap = completion.slice(-k);
    if (overlap !== suffix.slice(0, k)) continue;
    if (k >= MIN_TEXT_OVERLAP || CLOSING_RUN.test(overlap)) return completion.slice(0, -k);
  }
  return completion;
}

/* ── Citation grounding (LaTeX) ───────────────────────────────── */

/** A `\cite`-family command (natbib/biblatex variants included) and its
 *  brace argument. Reused to scan the window, where `\bibitem` below is the
 *  other place a key is legitimately visible in the file itself. */
const CITE_COMMAND = /\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]*)\}/g;
const BIBITEM = /\\bibitem(?:\[[^\]]*\])?\{([^}]*)\}/g;
/** A cite command the token cap (or the model) left unclosed at the tail. */
const CITE_UNCLOSED = /\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{[^}]*$/;

/** Every citation key the window itself shows (cite args + `\bibitem`s). */
function visibleCiteKeys(prefix: string, suffix: string): Set<string> {
  const keys = new Set<string>();
  const window = `${prefix}\n${suffix}`;
  // `matchAll` throughout, never `exec`: these regexes are module-level and
  // `/g`, so an `exec` loop leaves `lastIndex` on them for the next reader to
  // trip over. `matchAll` reads `lastIndex` but never writes it.
  for (const source of [CITE_COMMAND, BIBITEM]) {
    for (const match of window.matchAll(source)) {
      for (const key of (match[1] ?? '').split(',')) {
        const trimmed = key.trim();
        if (trimmed) keys.add(trimmed);
      }
    }
  }
  return keys;
}

/**
 * The deterministic half of the prompt's citation rule: the bibliography is
 * not in the window, so a key the window has never shown is invented — for a
 * famous paper the model produces a plausible key the project's `.bib` has
 * never heard of. The prompt now forbids this, but the prompt is tuned on the
 * default model only (a user-picked override was never in the notebook), and
 * it took three wordings before Haiku complied. The completion ends where the
 * first ungrounded citation begins; an unclosed cite at the tail is
 * unverifiable and ends it too.
 */
function truncateUngroundedCitations(completion: string, prefix: string, suffix: string): string {
  const commands = [...completion.matchAll(CITE_COMMAND)];
  const unclosed = CITE_UNCLOSED.exec(completion);
  if (commands.length === 0 && !unclosed) return completion;
  const known = visibleCiteKeys(prefix, suffix);
  // A multi-key command is one citation: any unseen key ends it whole.
  for (const command of commands) {
    const keys = (command[1] ?? '').split(',').map((key) => key.trim());
    if (keys.some((key) => !key || !known.has(key))) {
      return completion.slice(0, command.index).trimEnd();
    }
  }
  return unclosed ? completion.slice(0, unclosed.index).trimEnd() : completion;
}

/**
 * Raw model text → the string to render as ghost text, or `null` for "no
 * completion". Every rule here is a fixture in
 * `eval/autocomplete/post-processing.ts`.
 */
export function postProcessCompletion(
  raw: string | null | undefined,
  { prefix, suffix, language }: CompletionContext,
): string | null {
  if (!raw) return null;
  // The prefill anchor is not in a prefilled continuation, but a provider that
  // treats the prefill as an ordinary previous turn can echo it — and an
  // invisible character spliced into a paper is the worst kind of bug to find.
  let out = stripCodeFences(raw.split(INSERTION_ANCHOR).join(''));
  out = stripPrefixEcho(out, prefix);
  if (!out.trim()) return null;
  if (repeatsPrefix(out, prefix)) return null;
  out = trimSuffixOverlap(out, suffix);
  // LaTeX only: markdown legitimately quotes `\cite{...}` when writing ABOUT
  // LaTeX, and the deterministic suggest widget this rule defers to does not
  // exist there anyway.
  if (language === 'latex') out = truncateUngroundedCitations(out, prefix, suffix);
  // Monaco requires a multi-line inline completion to run to the end of the
  // line it starts on; with real text still after the cursor, keep one line.
  const lineBreak = suffix.indexOf('\n');
  const restOfLine = lineBreak === -1 ? suffix : suffix.slice(0, lineBreak);
  if (restOfLine.trim() && out.includes('\n')) out = out.slice(0, out.indexOf('\n'));
  const lines = out.split('\n');
  if (lines.length > MAX_COMPLETION_LINES) out = lines.slice(0, MAX_COMPLETION_LINES).join('\n');
  return out.trim() ? out : null;
}

/* ── LaTeX suggest-widget coexistence ─────────────────────────── */

/** Inside a `\ref{`/`\cite{`/`\begin{`/path argument, or partway through a
 *  control sequence — the deterministic LaTeX suggest widget owns the cursor
 *  there, and Tab must accept its selection, not ghost text. */
const LATEX_OPEN_ARG =
  /\\(?:[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])*|(?:eq|page|auto|name|c|C)?ref\*?|includegraphics(?:\[[^\]]*\])?|input|include|subfile|import|begin|end)\{[^}]*$/;

export function isLatexTriggerContext(linePrefix: string): boolean {
  return LATEX_OPEN_ARG.test(linePrefix) || /\\[a-zA-Z]*$/.test(linePrefix);
}

/* ── LRU cache ────────────────────────────────────────────────── */

export const DEFAULT_CACHE_CAPACITY = 20;

/**
 * How long a cached completion stays servable. Deliberately the same minute as
 * `AUTOCOMPLETE_GRANT_TTL_SECONDS` (which this file cannot import — that module
 * is server-only), because the two together are what make "a changed
 * autocomplete model reaches an open editor within a minute" true.
 *
 * Without an expiry the grant TTL only governs the NEXT request: entries here
 * carry no model, never go stale, and a cursor visited before the change keeps
 * serving the old model's text until one of 20 entries is evicted — which on a
 * quiet document is never.
 */
export const DEFAULT_CACHE_TTL_MS = 60_000;

/** FNV-1a: deterministic, dependency-free, and collision-safe enough when the
 *  key also carries the language and both segment lengths. */
function hash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * `document` is part of the key, not decoration: ONE register-once provider
 * serves every open editor from ONE LRU. Two documents with the same
 * boilerplate opening — split panes, a duplicated template, the same path in
 * two workspaces after an in-app navigation — would otherwise serve each
 * other's ghost text. Callers compose it from everything that changes what a
 * completion should be (the adapter uses `projectId` + `filePath`, both of
 * which reach the prompt or the route).
 *
 * Collision-safe despite the separator: the key also carries both segment
 * lengths verbatim, so a `␟` inside an input shifts those fields.
 */
export function cacheKey(
  prefix: string,
  suffix: string,
  language: string,
  document: string,
): string {
  const scope = `${language}␟${document}`;
  return `${scope}:${prefix.length}:${suffix.length}:${hash(`${prefix}␟${suffix}␟${scope}`)}`;
}

export type CompletionCache = {
  /** `undefined` = miss; `null` = a cached "no completion". */
  get(key: string): string | null | undefined;
  set(key: string, value: string | null): void;
  readonly size: number;
  clear(): void;
};

export function createCompletionCache(
  capacity: number = DEFAULT_CACHE_CAPACITY,
  ttlMs: number = DEFAULT_CACHE_TTL_MS,
  now: () => number = () => Date.now(),
): CompletionCache {
  const entries = new Map<string, { value: string | null; expiresAt: number }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry); // re-insert: Map iteration order IS the LRU order
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      while (entries.size > capacity) {
        const oldest = entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    get size() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}
