/**
 * The deterministic completion engine: no model, no network, no credits.
 *
 * Two rules, applied in order:
 *
 * 1. **Syntax closing** — an environment the window opens but never closes
 *    (`\begin{itemize}` → `\end{itemize}`, an unclosed markdown code fence)
 *    is completed structurally.
 * 2. **Term continuation** — finish the word under the cursor from vocabulary
 *    this document already uses, then extend with the words that followed its
 *    most recent earlier occurrence, up to {@link MAX_TERM_WORDS} words total.
 *    The document is the only source: nothing is suggested that the window
 *    hasn't literally shown.
 *
 * Pure and dependency-free like `engine.ts`: operates on the SAME bounded
 * prefix/suffix windows the AI path slices (never the whole document — the
 * O(change) keystroke invariant applies here too).
 */

import type { CompletionContext } from './engine';

/** "Up to 5 words" — the product spec, verbatim. */
export const MAX_TERM_WORDS = 5;

/** A boundary anchor shorter than this is noise (a, an, to, …). Mid-word
 *  partials only need 2 — `ap` → `apple` is a real completion. */
const MIN_ANCHOR_CHARS = 3;
const MIN_PARTIAL_CHARS = 2;

/** A word, for term purposes: letters/digits plus intra-word ' and -. */
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;

/* ── Syntax closing ───────────────────────────────────────────── */

const BEGIN_ENV = /\\begin\{([^}]+)\}/g;
const END_ENV = /\\end\{([^}]+)\}/g;

function countMatches(text: string, source: RegExp): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(source)) {
    const name = match[1]?.trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/** `\end{env}` for the innermost environment the window opens and never
 *  closes — only when the cursor line is otherwise finished (nothing after
 *  the cursor on it), so the close lands on its own line as LaTeX wants. */
function latexClose(prefix: string, suffix: string): string | null {
  const restOfLine = suffix.slice(0, suffix.indexOf('\n') === -1 ? suffix.length : suffix.indexOf('\n'));
  if (restOfLine.trim()) return null;
  const opened = countMatches(prefix, BEGIN_ENV);
  const closed = countMatches(`${prefix}\n${suffix}`, END_ENV);
  // Innermost = the LAST unbalanced \begin in the prefix.
  const begins = [...prefix.matchAll(BEGIN_ENV)];
  for (let i = begins.length - 1; i >= 0; i -= 1) {
    const name = begins[i]![1]!.trim();
    if (!name) continue;
    if ((opened.get(name) ?? 0) > (closed.get(name) ?? 0)) {
      // On the open line itself → close two lines down (leave a body line);
      // further along → close on the next line.
      const line = prefix.slice(prefix.lastIndexOf('\n') + 1);
      const onOpenLine = new RegExp(`\\\\begin\\{${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\s*$`).test(line);
      return onOpenLine ? `\n\n\\end{${name}}` : `\n\\end{${name}}`;
    }
  }
  return null;
}

/** Close an odd (unclosed) markdown code fence, when the cursor line is done. */
function markdownFenceClose(prefix: string, suffix: string): string | null {
  const restOfLine = suffix.slice(0, suffix.indexOf('\n') === -1 ? suffix.length : suffix.indexOf('\n'));
  if (restOfLine.trim()) return null;
  const fences = (text: string) => (text.match(/^\s*```/gm) ?? []).length;
  if ((fences(prefix) + fences(suffix)) % 2 === 1 && fences(prefix) % 2 === 1) {
    const line = prefix.slice(prefix.lastIndexOf('\n') + 1);
    return /^\s*```/.test(line) ? '\n\n```' : '\n```';
  }
  return null;
}

/* ── Term continuation ────────────────────────────────────────── */

type Token = { text: string; start: number };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(WORD)) {
    tokens.push({ text: match[0], start: match.index });
  }
  return tokens;
}

/** The partial word the cursor sits in, or null at a boundary. */
function partialWordAt(prefix: string): string | null {
  const match = /[\p{L}\p{N}'-]+$/u.exec(prefix);
  return match ? match[0] : null;
}

/** Words that follow `tokens[index]` verbatim in the source, respecting a
 *  sentence/line boundary: a continuation never crosses `.`, `!`, `?`, `:`
 *  or a newline — the document said those words END there. */
function continuationAfter(
  source: string,
  tokens: Token[],
  index: number,
  maxWords: number,
): string {
  let out = '';
  let cursor = tokens[index]!.start + tokens[index]!.text.length;
  for (let k = index + 1; k < tokens.length && maxWords > 0; k += 1, maxWords -= 1) {
    const between = source.slice(cursor, tokens[k]!.start);
    if (/[.!?:\n]/.test(between)) break;
    out += `${between}${tokens[k]!.text}`;
    cursor = tokens[k]!.start + tokens[k]!.text.length;
  }
  return out;
}

/**
 * Mid-word: complete the word from the document's vocabulary, then keep
 * copying the words that followed its most recent earlier occurrence.
 * At a word boundary (cursor after a space): use the finished previous word
 * as the anchor and propose what followed it last time.
 */
function termContinuation(prefix: string, suffix: string): string | null {
  const partial = partialWordAt(prefix);
  const anchorSource = partial ?? /([\p{L}\p{N}'-]+)[ \t]+$/u.exec(prefix)?.[1] ?? null;
  if (!anchorSource) return null;
  if (anchorSource.length < (partial ? MIN_PARTIAL_CHARS : MIN_ANCHOR_CHARS)) return null;

  // Vocabulary window: everything typed before the current partial word,
  // plus the suffix. (The partial itself must not match its own occurrence.)
  const before = partial ? prefix.slice(0, prefix.length - partial.length) : prefix;
  const beforeTokens = tokenize(before);

  if (partial) {
    // Most recent word starting with the partial (longer than it), scanned
    // backwards through the prefix, then forwards through the suffix.
    const candidates = [...beforeTokens].reverse();
    const suffixTokens = tokenize(suffix);
    const match =
      candidates.find((t) => t.text.length > partial.length && t.text.startsWith(partial)) ??
      suffixTokens.find((t) => t.text.length > partial.length && t.text.startsWith(partial));
    if (!match) return null;
    const wordRest = match.text.slice(partial.length);
    // Extend with what followed the completed word, from its own source text.
    const inPrefix = beforeTokens.includes(match);
    const sourceTokens = inPrefix ? beforeTokens : suffixTokens;
    const source = inPrefix ? before : suffix;
    const index = sourceTokens.indexOf(match);
    // Suffix matches never extend: the following words are already on screen.
    const rest = inPrefix ? continuationAfter(source, sourceTokens, index, MAX_TERM_WORDS - 1) : '';
    return `${wordRest}${rest}` || null;
  }

  // Boundary: anchor on the finished previous word's most recent EARLIER
  // occurrence and copy its continuation.
  for (let i = beforeTokens.length - 2; i >= 0; i -= 1) {
    if (beforeTokens[i]!.text !== anchorSource) continue;
    const rest = continuationAfter(before, beforeTokens, i, MAX_TERM_WORDS);
    const trimmed = rest.replace(/^[ \t]+/, '');
    if (!trimmed) return null;
    return ` ${trimmed}`;
  }
  return null;
}

/* ── Entry point ──────────────────────────────────────────────── */

/** The deterministic ghost text for this cursor, or null. Synchronous,
 *  bounded by the same windows as the AI path, and only ever emits text the
 *  document itself has shown (plus structural closers). */
export function deterministicCompletion({ prefix, suffix, language }: CompletionContext): string | null {
  if (!prefix.trim()) return null;
  const syntax =
    language === 'latex' ? latexClose(prefix, suffix) : language === 'markdown' ? markdownFenceClose(prefix, suffix) : null;
  if (syntax) return syntax;
  const term = termContinuation(prefix, suffix);
  if (!term) return null;
  // Never duplicate what already sits after the cursor: when the proposal and
  // the rest of the current line start the same way (either contains the
  // other's beginning), the document already has it.
  const proposal = term.trimStart();
  const lineEnd = suffix.indexOf('\n');
  const restOfLine = (lineEnd === -1 ? suffix : suffix.slice(0, lineEnd)).trimStart();
  if (restOfLine && (restOfLine.startsWith(proposal) || proposal.startsWith(restOfLine))) return null;
  return term;
}
