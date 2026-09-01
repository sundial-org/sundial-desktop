/**
 * Obsidian sub-note anchors — shared resolution for `[[note#heading]]`,
 * `[[note#^block-id]]` and end-of-line block IDs (`… ^id`).
 *
 * Pure functions over the parser.mjs Block AST so every consumer — click
 * navigation, the `[[` picker, and `![[…]]` embeds — matches identically.
 * Anchors resolve to top-level block RANGES ({ start, end }, end exclusive):
 * navigation scrolls to `start`, embeds/transclusion render the whole range.
 *
 * @typedef {import('./parser.mjs').Block} Block
 * @typedef {import('./parser.mjs').Inline} Inline
 * @typedef {{ path: string, heading: string | null, headingPath?: string[],
 *             blockId: string | null }} WikiTarget
 * @typedef {{ start: number, end: number }} AnchorRange
 */

import { parseInline } from './parser.mjs';

/**
 * Trailing block ID on a single LINE of text: ` ^id` at the end (or a line
 * that is nothing but `^id`). The space / line-start requirement keeps math
 * like `x^2` and mid-word carets literal. IDs are letters/digits/dashes.
 */
export const TRAILING_BLOCK_ID_RE = /(?:^|[ \t])\^([A-Za-z0-9-]+)$/;

/** @returns {{ id: string, index: number } | null} `index` = offset of the `^`. */
export function trailingBlockId(line) {
  const m = TRAILING_BLOCK_ID_RE.exec(line);
  if (!m) return null;
  return { id: m[1], index: line.length - m[1].length - 1 };
}

/**
 * Split a wikilink target into path + anchor. `[[#heading]]` (same-file) has
 * an empty path; a bare trailing `#` is treated as no anchor.
 *
 * A fragment containing `#` is ambiguous: `note#Top#Deep` is Obsidian's nested
 * heading path, but `note#C# Notes` is a heading whose NAME contains `#`.
 * `heading` is therefore the whole fragment and `headingPath` its segments;
 * resolveHeadingEntries tries the literal name first, then walks the segments
 * down the heading hierarchy — so both spellings resolve and the picker can
 * emit a heading name verbatim without escaping it.
 *
 * @param {string} target
 * @returns {WikiTarget}
 */
export function parseWikiTarget(target) {
  const raw = String(target ?? '').trim();
  const hash = raw.indexOf('#');
  if (hash === -1) return { path: raw, heading: null, blockId: null };
  const path = raw.slice(0, hash).trim();
  const fragment = raw.slice(hash + 1).trim();
  if (!fragment) return { path, heading: null, blockId: null };
  if (fragment.startsWith('^')) {
    return { path, heading: null, blockId: fragment.slice(1).trim() || null };
  }
  const segments = fragment.split('#').map((s) => s.trim()).filter(Boolean);
  return {
    path,
    heading: fragment,
    ...(segments.length > 1 ? { headingPath: segments } : {}),
    blockId: null,
  };
}

/**
 * Resolve a heading anchor over a flat list of top-level entries — the ONE
 * implementation, used by the AST resolver here and by the editor's live
 * ProseMirror matcher, which build `entries` from their own trees. Keeping
 * both on this function is what stops navigation and embeds from landing on
 * different headings.
 *
 * Order: the literal fragment first (so a heading NAMED `C# Notes` wins), then
 * Obsidian's nested path — each segment searched only INSIDE the section the
 * previous one opened, so `#Top#Deep` can't match a `Deep` that sits outside
 * `Top`. There is deliberately no loose "deepest segment anywhere" fallback:
 * that's what made the nested syntax pick the wrong heading.
 *
 * @param {Array<{ isHeading: boolean, level?: number, key?: string }>} entries
 * @param {{ heading?: string | null, headingPath?: string[] }} anchor
 * @returns {AnchorRange | null} indices into `entries`, end exclusive
 */
export function resolveHeadingEntries(entries, anchor) {
  // End of the section a heading opens: the next heading at the same or a
  // higher level, bounded by the enclosing section when we're descending.
  const sectionEnd = (index, hi) => {
    const level = entries[index].level ?? 1;
    let end = index + 1;
    while (end < hi && !(entries[end].isHeading && (entries[end].level ?? 1) <= level)) end += 1;
    return end;
  };
  const findIn = (want, lo, hi) => {
    for (let i = lo; i < hi; i += 1) {
      if (entries[i].isHeading && entries[i].key === want) return i;
    }
    return -1;
  };

  const literal = normalizeAnchorText(anchor?.heading ?? '');
  if (literal) {
    const hit = findIn(literal, 0, entries.length);
    if (hit !== -1) return { start: hit, end: sectionEnd(hit, entries.length) };
  }

  const segments = Array.isArray(anchor?.headingPath) ? anchor.headingPath : null;
  if (!segments || segments.length < 2) return null;
  let lo = 0;
  let hi = entries.length;
  let range = null;
  for (const segment of segments) {
    const want = normalizeAnchorText(segment);
    if (!want) return null;
    const hit = findIn(want, lo, hi);
    if (hit === -1) return null;
    const end = sectionEnd(hit, hi);
    range = { start: hit, end };
    // Descend: the next segment must live inside this heading's section.
    lo = hit + 1;
    hi = end;
  }
  return range;
}

/** Concatenated plain text of inline runs; hard breaks become newlines. */
function inlinePlainText(inline) {
  let out = '';
  for (const node of inline ?? []) {
    if (node.type === 'text') out += node.text;
    else if (node.type === 'hardBreak') out += '\n';
  }
  return out;
}

/**
 * Same text with inline-code spans masked to a char no ID can contain, so a
 * line ending in `` `cmd ^tmp` `` doesn't read as a block ID. Length-preserving:
 * offsets into the mask map 1:1 onto the plain text.
 */
function inlineIdScanText(inline) {
  let out = '';
  for (const node of inline ?? []) {
    if (node.type === 'hardBreak') out += '\n';
    // A non-text leaf (an inline image) occupies the line even though it
    // contributes no text. SKIPPING it left `![x](a.png)^foo` looking like a
    // line that is nothing but `^foo`, i.e. a standalone id attaching to the
    // previous block — while the editor's scanner, which masks non-text nodes,
    // saw no id at all. Mask it here too so the two agree.
    else if (node.type !== 'text') out += ID_MASK;
    // Code and LINK text are references, not the block's own content. A block
    // link's alias ends in `^id` by construction (`[[other#^p1|other ^p1]]`),
    // so any paragraph ending with one would otherwise claim that id itself —
    // and a same-file `#^p1` could resolve to the paragraph doing the
    // referencing instead of the block being referenced.
    else if ((node.marks ?? []).some((m) => m.type === 'code' || m.type === 'link' || m.type === 'wikilink')) {
      out += ID_MASK.repeat(node.text.length);
    }
    else out += node.text;
  }
  return out;
}

// Non-whitespace so a masked code span can't satisfy the regex's `[ \t]`
// prefix and fake an id (`run `cmd`^tmp`). Written as an escape so the file
// stays plain text. Exported: the editor's decoration scanner MUST use the
// same mask or the live view and the resolver disagree about what is an id.
export const ID_MASK = '\u0000';

/**
 * Split a trailing block ID off inline content: `## Results ^sec-1` is the
 * heading "Results" carrying id `sec-1`, not a heading literally named
 * "Results ^sec-1". Inline code is masked first, so `` `x ^y` `` stays text.
 */
function splitTrailingId(inline) {
  const text = inlinePlainText(inline);
  const scan = inlineIdScanText(inline);
  const lastLine = scan.slice(scan.lastIndexOf('\n') + 1);
  const found = trailingBlockId(lastLine.replace(/[ \t]+$/, ''));
  if (!found) return { text, id: null };
  // Strip the id off the END of the plain text rather than slicing at an
  // offset taken from the scan: the two strings are no longer the same length
  // (a masked image is one char but no text at all), and an id is always real
  // trailing text — masked spans can't contain id characters.
  const stripped = text.replace(new RegExp(`[ \\t]*\\^${found.id.replace(/[-]/g, '\\$&')}[ \\t]*$`), '');
  return { text: stripped, id: found.id };
}

/**
 * Forgiving heading comparison key: inline markdown stripped (via the shared
 * parser, never a second regex stripper), whitespace collapsed, lowercased.
 * Punctuation is kept — matching follows Obsidian's literal-text semantics.
 */
export function normalizeAnchorText(text) {
  // The link FRAGMENT is matched literally (inline markdown stripped) — no
  // trailing-id removal here. Only the heading side drops its id, so what
  // listHeadingAnchors offers is exactly what resolves; stripping here too
  // would break a heading whose text legitimately ends in `^…` inside code.
  return normalizeInlineText(inlinePlainText(parseInline(String(text ?? ''))));
}

function normalizeInlineText(text) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The heading-matching key for already-parsed inline nodes — the ONE rule,
 * shared by the AST resolver here and the editor's live ProseMirror matcher
 * (which builds parser-shaped inline from the heading node). Keeping both on
 * this function is what stops navigation and embeds from disagreeing about
 * which heading an anchor names.
 */
export function normalizeAnchorInline(inline) {
  return normalizeInlineText(splitTrailingId(inline).text);
}

/** Heading text WITHOUT its trailing block id — `## Results ^sec-1` is
 *  addressable as `[[note#Results]]`, and the id stays a badge. */
function headingKey(block) {
  return normalizeAnchorInline(block.inline);
}

/** All plain-text LINES inside a block, recursing into lists/quotes/callouts.
 *  Inline code is masked so `` `cmd ^tmp` `` can't read as a block id. */
function blockLines(block, out = []) {
  switch (block?.type) {
    case 'paragraph':
    case 'heading':
      for (const line of inlineIdScanText(block.inline).split('\n')) out.push(line);
      break;
    case 'bulletList':
    case 'orderedList':
      for (const item of block.items ?? []) for (const child of item) blockLines(child, out);
      break;
    case 'blockquote':
    case 'callout':
      for (const child of block.children ?? []) blockLines(child, out);
      break;
    default:
      break;
  }
  return out;
}

/** A paragraph that is nothing but `^id` — Obsidian's "ID for the previous
 *  block" form (used after tables/code fences, which can't carry a suffix). */
function standaloneIdOf(block) {
  if (block?.type !== 'paragraph') return null;
  const text = inlineIdScanText(block.inline).trim();
  const m = /^\^([A-Za-z0-9-]+)$/.exec(text);
  return m ? m[1] : null;
}

function blockHasId(block, wantLower) {
  return blockLines(block).some((line) => {
    const found = trailingBlockId(line.trimEnd());
    return found != null && found.id.toLowerCase() === wantLower;
  });
}

/**
 * The block's own ID: the first trailing id on ANY of its lines. Multi-line
 * blocks (lists, callouts) can carry it on an inner line — `- alpha ^a` /
 * `- beta` — and resolution accepts those, so the picker has to see the same
 * ones or an existing anchor looks absent.
 */
function blockOwnId(block) {
  for (const line of blockLines(block)) {
    const found = trailingBlockId(line.trimEnd());
    if (found) return found.id;
  }
  return null;
}

/**
 * Resolve an anchor against top-level blocks. Heading anchors span the whole
 * section (up to the next heading of same-or-higher level); block anchors span
 * the single carrying block. First match in document order wins. A standalone
 * `^id` paragraph resolves to the block BEFORE it.
 *
 * @param {Block[]} blocks
 * @param {{ heading?: string | null, blockId?: string | null }} anchor
 * @returns {AnchorRange | null}
 */
export function resolveAnchor(blocks, anchor) {
  if (anchor?.heading) {
    return resolveHeadingEntries(
      blocks.map((b) => ({
        isHeading: b.type === 'heading',
        level: b.level,
        key: b.type === 'heading' ? headingKey(b) : undefined,
      })),
      anchor,
    );
  }
  if (anchor?.blockId) {
    const want = anchor.blockId.toLowerCase();
    for (let i = 0; i < blocks.length; i += 1) {
      const standalone = standaloneIdOf(blocks[i]);
      if (standalone != null) {
        if (standalone.toLowerCase() === want && i > 0) return { start: i - 1, end: i };
        continue;
      }
      if (blockHasId(blocks[i], want)) return { start: i, end: i + 1 };
    }
    return null;
  }
  return null;
}

/** Headings of a note, for the `[[note#` picker. */
export function listHeadingAnchors(blocks) {
  const out = [];
  for (const block of blocks) {
    if (block.type !== 'heading') continue;
    // Offer "Results", not "Results ^sec-1" — the id is a badge, and a link
    // built from it has to match headingKey.
    const text = splitTrailingId(block.inline).text.replace(/\s+/g, ' ').trim();
    if (text) out.push({ level: block.level, text });
  }
  return out;
}

function blockPreviewText(block) {
  switch (block?.type) {
    case 'paragraph':
    case 'heading':
      return inlinePlainText(block.inline).replace(/\s+/g, ' ').trim();
    case 'bulletList':
    case 'orderedList': {
      const first = (block.items ?? []).flat().map(blockPreviewText).find(Boolean) ?? '';
      return first && `• ${first}`;
    }
    case 'blockquote':
    case 'callout': {
      const first = (block.children ?? []).map(blockPreviewText).find(Boolean) ?? '';
      return first && `> ${first}`;
    }
    case 'codeBlock':
      return (block.text ?? '').split('\n')[0].trim();
    case 'table':
      return (block.header ?? []).map((cell) => inlinePlainText(cell).trim()).filter(Boolean).join(' · ');
    default:
      return '';
  }
}

/**
 * Blocks of a note that a `[[note#^id]]` link can already target, for the
 * `[[note#^` picker: every top-level block (headings link via `#`) that
 * carries an ID — its own trailing `^id`, or a standalone `^id` line after it.
 *
 * Blocks WITHOUT an ID are deliberately not listed. Generating one means
 * writing to a note the user isn't editing, and the only server-side path for
 * that today round-trips the doc through markdown, which silently accepts any
 * pending suggestions in that file. Until there's a mark-preserving positional
 * write, authoring an ID stays manual: type ` ^id` at the end of the line.
 *
 * @returns {Array<{ index: number, preview: string, id: string }>}
 */
export function listBlockAnchors(blocks) {
  const out = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.type === 'heading' || block.type === 'horizontalRule') continue;
    if (standaloneIdOf(block) != null) continue;
    const preview = blockPreviewText(block);
    if (!preview) continue;
    const id = blockOwnId(block) ?? standaloneIdOf(blocks[i + 1]);
    if (!id) continue;
    out.push({ index: i, preview: preview.slice(0, 120), id });
  }
  return out;
}

/**
 * Resolve a wikilink path against workspace file paths, Obsidian-style:
 * exact, then case-insensitive, then with `.md` appended, then as a path
 * suffix, then by bare basename (`note` matches a note.md anywhere in the
 * tree). Returns the matching workspace path or null.
 */
export function resolveWorkspacePath(target, paths) {
  const raw = String(target ?? '').replace(/^\.\//, '').replace(/^\/+/, '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const found =
    paths.find((p) => p === raw) ??
    paths.find((p) => p.toLowerCase() === lower) ??
    paths.find((p) => p.toLowerCase() === `${lower}.md`) ??
    paths.find((p) => p.toLowerCase().endsWith(`/${lower}`)) ??
    paths.find((p) => p.toLowerCase().endsWith(`/${lower}.md`));
  if (found) return found;
  if (raw.includes('/')) return null;
  const stripMd = (s) => (s.endsWith('.md') ? s.slice(0, -3) : s);
  const wantBase = stripMd(lower);
  return paths.find((p) => stripMd((p.split('/').pop() ?? '').toLowerCase()) === wantBase) ?? null;
}
