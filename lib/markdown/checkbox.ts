// The leading task-state marker of a checklist line. Checklist items are not a
// node type here — they are ordinary listItems whose paragraph STARTS with
// `[ ]` / `[x]` (or an Obsidian custom state), decorated into a checkbox by the
// editor. That makes the marker plain text, so anything editing the start of a
// list line has to know where it ends; this module is the single place that
// decides (the editor's decorations + Enter handler, and the list-join keys).

// Matches any single-char task state at start of text: [ ] / [x] plus Obsidian
// custom states ([?], [-], [/], …). Custom states are gated to list items in
// the decoration builder so a paragraph starting `[1] Ref` isn't a checkbox.
export const CHECKBOX_RE = /^\[([^[\]])\]/;

/**
 * Shared task-state predicate (decorations + Enter handler). Classic [ ]/[x]
 * match anywhere (legacy behavior); a custom state counts only with a space
 * (or end of text) after the `]` — mirrors the parser's task rule, so
 * `- [1]Ref` is a plain item, not a checklist.
 */
export function checkboxStateAt(text: string): { state: string; classic: boolean } | null {
  const m = text.match(CHECKBOX_RE);
  if (!m) return null;
  const state = m[1]!;
  const classic = state === ' ' || state.toLowerCase() === 'x';
  // Custom states are SYMBOLS only (`[?]`, `[-]`, `[/]`, …): an alphanumeric
  // bracket is a citation/reference marker (`- [1] Knuth`), not a task.
  if (!classic && /[a-zA-Z0-9]/.test(state)) return null;
  if (!classic && text.length > 3 && !/\s/.test(text[3]!)) return null;
  return { state, classic };
}

/**
 * How many leading characters of `text` are the task marker, including the one
 * space that separates it from the label — 0 when the line isn't a checklist
 * item. Joining two list lines drops the marker of the line being merged IN:
 * a line carries at most one marker, and it belongs to the line that survives.
 */
export function checkboxMarkerLength(text: string): number {
  if (!checkboxStateAt(text)) return 0;
  return text[3] === ' ' ? 4 : 3;
}
