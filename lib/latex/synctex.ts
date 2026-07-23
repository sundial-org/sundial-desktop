/**
 * Dependency-free SyncTeX (`.synctex.gz`) parser for click-to-source (W4.synctex).
 *
 * Tectonic's V2 CLI (`-X compile --synctex`) emits `<root>.synctex.gz` next to
 * the PDF. We persist it as a `files` row and fetch it in the viewer. This module
 * gunzips + parses the text records into two indexes:
 *   - **forward** (file,line) → {page, x, y}: jump the PDF to a source line.
 *   - **inverse** (page, xPt, yPt) → {file, line}: double-click PDF → source line.
 *
 * SyncTeX coordinates are scaled points (sp); 1 PDF point (bp) = 65781.76 sp
 * (= 65536 × 72.27/72). All exported coordinates are in PDF points from the page
 * top-left (y increases downward), matching what react-pdf reports for a page.
 */

const SP_PER_PT = 65781.76;
// Parse budget — a pathological/huge synctex file can't stall the UI thread.
const MAX_RECORDS = 500_000;

export type SyncTexForwardHit = { page: number; x: number; y: number };
export type SyncTexInverseHit = { file: string; line: number };

export type SyncTexIndex = {
  forward(file: string, line: number): SyncTexForwardHit | null;
  inverse(page: number, xPt: number, yPt: number): SyncTexInverseHit | null;
};

type Box = { x: number; y: number; w: number; h: number; d: number; file: string; line: number };

// Record line: leading type char, then `tag,line:x,y` and optional `:W,H,D`.
// Types that carry a point: boxes `[ ( h v`, glyph/kern/glue/math `x k g $`.
const RECORD_RE = /^[[(hvxkg$](\d+),(\d+):(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+))?/;

function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').trim();
}

function basename(p: string): string {
  const norm = normalizePath(p);
  const i = norm.lastIndexOf('/');
  return i === -1 ? norm : norm.slice(i + 1);
}

/** Parse already-decompressed SyncTeX text. Exposed for unit tests + reuse. */
export function parseSyncTexText(text: string): SyncTexIndex {
  const tagToFile = new Map<number, string>();
  // forward: `${tag}:${line}` → first point seen (topmost in reading order).
  const forwardRecords = new Map<string, SyncTexForwardHit>();
  // forward fallback: per tag, the sorted set of lines that have a record.
  const linesByTag = new Map<number, Set<number>>();
  const boxesByPage = new Map<number, Box[]>();

  let page = 0;
  let inContent = false;
  let records = 0;

  const lines = text.split('\n');
  for (const raw of lines) {
    if (records >= MAX_RECORDS) break;
    if (!inContent) {
      if (raw.startsWith('Input:')) {
        // `Input:<tag>:<path>` — path may itself contain colons.
        const rest = raw.slice('Input:'.length);
        const colon = rest.indexOf(':');
        if (colon !== -1) {
          const tag = Number(rest.slice(0, colon));
          const path = rest.slice(colon + 1);
          if (Number.isFinite(tag)) tagToFile.set(tag, path);
        }
      } else if (raw.startsWith('Content:')) {
        inContent = true;
      }
      continue;
    }

    const c = raw.charCodeAt(0);
    // Page open `{<n>` / close `}<n>`; SyncTeX also uses `<`/`>` for sheets.
    if (c === 123 /* { */) {
      page = Number(raw.slice(1)) || page;
      continue;
    }
    if (c === 125 /* } */) continue;

    const m = RECORD_RE.exec(raw);
    if (!m) continue;
    records++;
    const tag = Number(m[1]);
    const line = Number(m[2]);
    const x = Number(m[3]) / SP_PER_PT;
    const y = Number(m[4]) / SP_PER_PT;

    const key = `${tag}:${line}`;
    if (!forwardRecords.has(key)) forwardRecords.set(key, { page, x, y });
    let lset = linesByTag.get(tag);
    if (!lset) {
      lset = new Set<number>();
      linesByTag.set(tag, lset);
    }
    lset.add(line);

    // Box records carry extents (W,H,D) → usable for inverse hit-testing.
    if (m[5] !== undefined) {
      const file = tagToFile.get(tag);
      if (file) {
        const w = Number(m[5]) / SP_PER_PT;
        const h = Number(m[6]) / SP_PER_PT;
        const d = Number(m[7]) / SP_PER_PT;
        let list = boxesByPage.get(page);
        if (!list) {
          list = [];
          boxesByPage.set(page, list);
        }
        list.push({ x, y, w, h, d, file: normalizePath(file), line });
      }
    }
  }

  function tagFor(file: string): number | null {
    // Prefer an exact / path-suffix match; only fall back to a bare basename
    // match when nothing stronger exists, so two inputs sharing a basename
    // (`sections/intro.tex` vs `appendix/intro.tex`) resolve to the right file.
    const q = normalizePath(file);
    let basenameTag: number | null = null;
    for (const [tag, path] of tagToFile) {
      const p = normalizePath(path);
      if (p === q || p.endsWith('/' + q) || q.endsWith('/' + p)) return tag;
      if (basenameTag === null && basename(p) === basename(q)) basenameTag = tag;
    }
    return basenameTag;
  }

  return {
    forward(file, line) {
      const tag = tagFor(file);
      if (tag === null) return null;
      const exact = forwardRecords.get(`${tag}:${line}`);
      if (exact) return exact;
      // No record on that exact line (blank/comment) — snap to the nearest line
      // that does have one, so forward search still lands somewhere sensible.
      const lset = linesByTag.get(tag);
      if (!lset) return null;
      let best: number | null = null;
      let bestDist = Infinity;
      for (const l of lset) {
        const dist = Math.abs(l - line);
        if (dist < bestDist) {
          bestDist = dist;
          best = l;
        }
      }
      return best === null ? null : forwardRecords.get(`${tag}:${best}`) ?? null;
    },

    inverse(page, xPt, yPt) {
      const boxes = boxesByPage.get(page);
      if (!boxes || boxes.length === 0) return null;
      let best: Box | null = null;
      let bestScore = Infinity;
      let bestH = Infinity;
      for (const box of boxes) {
        const top = box.y - box.h;
        const bottom = box.y + box.d;
        const vDist = yPt < top ? top - yPt : yPt > bottom ? yPt - bottom : 0;
        const hDist = xPt < box.x ? box.x - xPt : xPt > box.x + box.w ? xPt - (box.x + box.w) : 0;
        // Score: vertical gap + box height. Adding the height demotes the
        // page-spanning vbox (tagged with one line, emitted first) so a click
        // resolves to the nearest tight line box; hDist breaks ties.
        const score = vDist + (bottom - top);
        if (score < bestScore || (score === bestScore && hDist < bestH)) {
          bestScore = score;
          bestH = hDist;
          best = box;
        }
      }
      return best ? { file: best.file, line: best.line } : null;
    },
  };
}

async function gunzipToText(input: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  // `DecompressionStream` is available in modern browsers and Node ≥18.
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new TextDecoder('utf-8').decode(buf);
}

/** Gunzip + parse a `.synctex.gz` blob into a queryable index. */
export async function parseSyncTex(input: ArrayBuffer | Uint8Array): Promise<SyncTexIndex> {
  const text = await gunzipToText(input);
  return parseSyncTexText(text);
}
