// Single source of truth for the optional `{…}` attribute suffix on a markdown
// image — width (px) and alignment. Shared by the parser, both serializers, the
// crdt-js codec and the editor schema so a styled image round-trips losslessly.
// Plain `.mjs` so the `.mjs` codec and the `.ts` editor/schema can all import it.

// Max px width that round-trips exactly — the suffix only reads a 1–5 digit
// width, so a value we could emit but not read back would silently stop being a
// sized image on reload. Keep emit + parse in lockstep.
const MAX_IMAGE_WIDTH = 99999;
// Only non-default alignments are encoded; `left` is the default, so it needs no
// suffix (clicking "align left" just clears the attribute).
const ALIGNMENTS = new Set(['center', 'right']);

/** `![alt](src)` plus a `{…}` suffix for any set attributes (`{ width, align }`). */
export function imageMarkdown(alt, src, attrs) {
  return `![${alt}](${src})${imageAttrsSuffix(attrs)}`;
}

/** `{width=N align=center}` in canonical order, or '' when nothing valid is set. */
export function imageAttrsSuffix(attrs) {
  const parts = [];
  const w = Math.round(Number(attrs?.width));
  if (Number.isFinite(w) && w > 0 && w <= MAX_IMAGE_WIDTH) parts.push(`width=${w}`);
  if (ALIGNMENTS.has(attrs?.align)) parts.push(`align=${attrs.align}`);
  return parts.length ? `{${parts.join(' ')}}` : '';
}

/** Parse a trailing `{…}` block to `{ width?, align? }`, or null when it isn't a
 *  valid attribute block — so the caller keeps the braces as literal text. */
export function parseImageAttrs(block) {
  const inner = block.replace(/^\{|\}$/g, '').trim();
  if (!inner) return null;
  const out = {};
  for (const token of inner.split(/\s+/)) {
    const w = token.match(/^width=([1-9]\d{0,4})$/);
    const a = token.match(/^align=(center|right)$/);
    if (w) out.width = Number(w[1]);
    else if (a) out.align = a[1];
    else return null; // unknown token → not an attribute block
  }
  return Object.keys(out).length ? out : null;
}

/** Tiptap/ProseMirror `width` attribute: integer px ↔ the HTML `width` attr.
 *  (Alignment rides on the shared TextAlign extension's `textAlign` attribute.) */
export const imageWidthAttribute = {
  width: {
    default: null,
    parseHTML: (el) => {
      const w = parseInt(el.getAttribute('width') || '', 10);
      return Number.isFinite(w) && w > 0 && w <= MAX_IMAGE_WIDTH ? w : null;
    },
    renderHTML: (attrs) => (attrs.width ? { width: attrs.width } : {}),
  },
};
