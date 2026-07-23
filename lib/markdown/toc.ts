// Lightweight table-of-contents extraction for the markdown editor sidebar.
// Scans ATX headings (`#`…`######`) in document order, skipping fenced code
// blocks so a `# comment` inside ``` doesn't show up as a heading. The index of
// each entry matches the Nth heading element in the rendered `.tiptap` doc, so
// the sidebar can scroll to it without anchors/ids.

export type TocHeading = {
  /** 1–6 */
  level: number;
  /** Heading text, inline markdown stripped to plain text. */
  text: string;
  /** 0-based position among all headings, in document order. */
  index: number;
};

const ATX = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** Strip the inline markdown that would otherwise clutter a TOC label. */
function stripInline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .trim();
}

export function extractMarkdownHeadings(markdown: string): TocHeading[] {
  const out: TocHeading[] = [];
  let inFence = false;
  for (const rawLine of (markdown ?? "").split("\n")) {
    if (FENCE.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = ATX.exec(rawLine);
    if (!m) continue;
    const text = stripInline(m[2] ?? "");
    if (!text) continue;
    out.push({ level: m[1].length, text, index: out.length });
  }
  return out;
}
