/**
 * Obsidian callout type vocabulary — the canonical types and the aliases that
 * render as one of them.
 *
 * This is a RENDER-TIME mapping only. The parser, the Y.Doc (`calloutType`) and
 * the markdown all keep the alias the user typed, so `> [!tldr]` round-trips as
 * `> [!tldr]`; only the styling hook (`data-callout-resolved`) and the icon are
 * resolved to `abstract`. Unknown types resolve to null and keep the neutral
 * default styling.
 */

/** Canonical Obsidian callout types, each with its own icon + color group. */
export const CALLOUT_TYPES = [
  'note',
  'abstract',
  'info',
  'todo',
  'tip',
  'success',
  'question',
  'warning',
  'failure',
  'danger',
  'bug',
  'example',
  'quote',
];

/** alias → canonical type. Mirrors Obsidian's built-in callout aliases. */
export const CALLOUT_ALIASES = {
  summary: 'abstract',
  tldr: 'abstract',
  hint: 'tip',
  important: 'tip',
  check: 'success',
  done: 'success',
  help: 'question',
  faq: 'question',
  attention: 'warning',
  caution: 'warning',
  fail: 'failure',
  missing: 'failure',
  error: 'danger',
  cite: 'quote',
};

/**
 * Canonical type for a callout type as typed, or null when it's neither a known
 * type nor a known alias (unknown types keep the default styling).
 *
 * @param {string | null | undefined} type
 * @returns {string | null}
 */
export function resolveCalloutType(type) {
  if (!type) return null;
  const key = String(type).trim().toLowerCase();
  if (CALLOUT_TYPES.includes(key)) return key;
  return CALLOUT_ALIASES[key] ?? null;
}
