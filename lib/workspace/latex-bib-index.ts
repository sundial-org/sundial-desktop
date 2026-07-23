/**
 * Project `.bib` index (W1.bibindex). Pure, dependency-free parser shared by the
 * Next client (citation picker / `\cite{` autocomplete) and server callers — it
 * takes already-loaded file contents, so it never touches the DB or filesystem.
 *
 * Parses every `.bib` file in a project into `{key, title, authors, year,
 * sourceFile}` entries. BibTeX-tolerant: `{}`/`()` entry delimiters, `{...}`/
 * `"..."`/bare field values, nested braces, `#` concatenation, and `@string`/
 * `@preamble`/`@comment` blocks (which are skipped, not indexed).
 */

import { getExtension } from '@/lib/sync/policy';

export type BibEntry = {
  /** Citation key, e.g. `smith2020`. */
  key: string;
  /** Entry type without the `@`, lowercased, e.g. `article`, `inproceedings`. */
  type: string;
  /** Cleaned title, or `''` when absent. */
  title: string;
  /** Author display names (`First Last`), `editor` used as fallback. */
  authors: string[];
  /** Four-digit year as a string, or `''` when absent. */
  year: string;
  /** Workspace-relative path of the `.bib` file the entry came from. */
  sourceFile: string;
  /** All other cleaned fields, so downstream surfaces need not re-parse. */
  fields: Record<string, string>;
};

export type BibFileInput = { path: string; text: string | null | undefined };

const SKIP_TYPES = new Set(['string', 'preamble', 'comment']);

/** Collapse whitespace and strip BibTeX brace/escape noise from a field value. */
function cleanValue(raw: string): string {
  return raw
    .replace(/\s+/gu, ' ')
    .replace(/[{}]/gu, '')
    .replace(/\\&/gu, '&')
    .replace(/~/gu, ' ')
    .trim();
}

/** Index of the delimiter that closes the entry body opened at `open` (`{`/`(`). */
function findEntryEnd(text: string, open: number): number {
  const openChar = text[open];
  if (openChar === '{') {
    let depth = 1;
    for (let i = open + 1; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}' && (depth -= 1) === 0) return i;
    }
    return -1;
  }
  // Parenthesised entry: braces still nest; a `)` inside `{}` does not close it.
  let brace = 0;
  for (let i = open + 1; i < text.length; i += 1) {
    const c = text[i];
    if (c === '{') brace += 1;
    else if (c === '}') brace = Math.max(0, brace - 1);
    else if (c === ')' && brace === 0) return i;
  }
  return -1;
}

/** Read one field value (`{...}` / `"..."` / bare, joined across `#`). */
function readValue(body: string, start: number): { value: string; next: number } {
  let i = start;
  const segments: string[] = [];
  for (;;) {
    while (i < body.length && /\s/u.test(body[i]!)) i += 1;
    const c = body[i];
    if (c === '{') {
      let depth = 1;
      const from = i + 1;
      i += 1;
      while (i < body.length && depth > 0) {
        if (body[i] === '{') depth += 1;
        else if (body[i] === '}') depth -= 1;
        if (depth > 0) i += 1;
      }
      segments.push(body.slice(from, i));
      i += 1;
    } else if (c === '"') {
      let brace = 0;
      const from = i + 1;
      i += 1;
      while (i < body.length && !(body[i] === '"' && brace === 0)) {
        if (body[i] === '{') brace += 1;
        else if (body[i] === '}') brace = Math.max(0, brace - 1);
        i += 1;
      }
      segments.push(body.slice(from, i));
      i += 1;
    } else {
      const from = i;
      while (i < body.length && !/[,#]/u.test(body[i]!)) i += 1;
      segments.push(body.slice(from, i).trim());
    }
    while (i < body.length && /\s/u.test(body[i]!)) i += 1;
    if (body[i] === '#') {
      i += 1;
      continue;
    }
    break;
  }
  return { value: segments.join(''), next: i };
}

/** Split on ` and ` separators at brace depth 0 (so `{Barnes and Noble}` is atomic). */
function splitOnAnd(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === '{') depth += 1;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /\s/u.test(c)) {
      const m = /^\s+and\s+/iu.exec(raw.slice(i));
      if (m) {
        parts.push(raw.slice(start, i));
        i += m[0].length;
        start = i;
        continue;
      }
    }
    i += 1;
  }
  parts.push(raw.slice(start));
  return parts;
}

/** Split a BibTeX `author`/`editor` value into `First Last` display names. */
function parseNames(raw: string): string[] {
  return splitOnAnd(raw)
    .map((name) => {
      const comma = name.indexOf(',');
      const swapped = comma === -1 ? name : `${name.slice(comma + 1)} ${name.slice(0, comma)}`;
      return cleanValue(swapped);
    })
    .filter(Boolean);
}

/** Parse the fields of a single entry body (everything after the key). */
function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s,]/u.test(body[i]!)) i += 1;
    const nameMatch = /^[A-Za-z][\w-]*/u.exec(body.slice(i));
    if (!nameMatch) break;
    const name = nameMatch[0].toLowerCase();
    i += nameMatch[0].length;
    while (i < body.length && /\s/u.test(body[i]!)) i += 1;
    if (body[i] !== '=') break;
    i += 1;
    const { value, next } = readValue(body, i);
    // Store raw (braces intact) so name fields can split on top-level ` and `;
    // callers clean per-field at point of use.
    if (!(name in fields)) fields[name] = value;
    i = next;
  }
  return fields;
}

/** Parse every entry in one `.bib` document's text. */
export function parseBibEntries(text: string, sourceFile = ''): BibEntry[] {
  const entries: BibEntry[] = [];
  const at = /@([A-Za-z]+)\s*[{(]/gu;
  let m: RegExpExecArray | null;
  while ((m = at.exec(text))) {
    const type = m[1]!.toLowerCase();
    const open = at.lastIndex - 1;
    const end = findEntryEnd(text, open);
    if (end === -1) {
      // Unterminated entry: skip past its opening delimiter and keep scanning,
      // so one missing brace doesn't drop the rest of the bibliography (IC6).
      at.lastIndex = open + 1;
      continue;
    }
    at.lastIndex = end + 1;
    if (SKIP_TYPES.has(type)) continue;
    const inner = text.slice(open + 1, end);
    const comma = inner.indexOf(',');
    const key = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    if (!key) continue;
    const fields = comma === -1 ? {} : parseFields(inner.slice(comma + 1));
    const { author, editor, title, year, date, ...rest } = fields;
    const cleanedRest: Record<string, string> = {};
    for (const fieldName in rest) cleanedRest[fieldName] = cleanValue(rest[fieldName]!);
    entries.push({
      key,
      type,
      title: cleanValue(title ?? ''),
      authors: parseNames(author || editor || ''),
      year: (year || date || '').match(/\d{4}/u)?.[0] ?? '',
      sourceFile,
      fields: cleanedRest,
    });
  }
  return entries;
}

/**
 * Build the project-wide index from a set of files. Non-`.bib` files are
 * ignored; duplicate citation keys keep the first occurrence (a key collision is
 * invalid LaTeX anyway), so the result is safe to feed a picker directly.
 */
export function buildBibIndex(files: BibFileInput[]): BibEntry[] {
  const seen = new Set<string>();
  const index: BibEntry[] = [];
  for (const file of files) {
    if (getExtension(file.path) !== '.bib' || !file.text) continue;
    for (const entry of parseBibEntries(file.text, file.path)) {
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      index.push(entry);
    }
  }
  return index;
}

/**
 * Filter/rank entries for a `\cite{` picker. Every whitespace-separated token
 * must appear in the key/title/authors/year haystack; results rank key matches
 * (exact → prefix → substring) ahead of metadata-only matches.
 */
export function searchBibEntries(entries: BibEntry[], query: string, limit = 50): BibEntry[] {
  const tokens = query.toLowerCase().trim().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return entries.slice(0, limit);
  const scored: { entry: BibEntry; score: number }[] = [];
  for (const entry of entries) {
    const key = entry.key.toLowerCase();
    const haystack = `${key} ${entry.title} ${entry.authors.join(' ')} ${entry.year}`.toLowerCase();
    if (!tokens.every((t) => haystack.includes(t))) continue;
    const score = Math.min(...tokens.map((t) => (key === t ? 0 : key.startsWith(t) ? 1 : key.includes(t) ? 2 : 3)));
    scored.push({ entry, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.entry.key.localeCompare(b.entry.key))
    .slice(0, limit)
    .map((s) => s.entry);
}
