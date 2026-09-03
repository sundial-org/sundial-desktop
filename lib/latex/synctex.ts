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
/** A horizontal slice of rendered material (PDF pt, top-left origin; y is the
 *  baseline) that a source line range produced — one per rendered-line run. */
export type SyncTexSpan = { page: number; x: number; y: number; w: number };

export type SyncTexIndex = {
  forward(file: string, line: number): SyncTexForwardHit | null;
  inverse(page: number, xPt: number, yPt: number): SyncTexInverseHit | null;
  /** All rendered material for source lines [startLine, endLine] of `file`,
   *  from the word records' end-marker intervals — what a comment highlight
   *  paints over the PDF. Junk-tagged leading records contribute nothing. */
  forwardSpans(file: string, startLine: number, endLine: number): SyncTexSpan[];
};

type Box = { x: number; y: number; w: number; h: number; d: number; file: string; line: number };
type Point = { x: number; y: number; file: string; line: number };

// A word-level point only refines the inverse hit when the click is really on
// that text line: within one line-height of the point's baseline.
const POINT_REFINE_MAX_VDIST_PT = 12;

// Record line: leading type char, then `tag,line:x,y` and optional `:W,H,D`.
// Types that carry a point: boxes `[ ( h v`, glyph/kern/glue/math `x k g $`.
const RECORD_RE = /^[[(hvxkg$](\d+),(\d+):(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+))?/;

/** Resolve `.`/`..` segments and drop empty ones (`a/./b/../c` → `a/c`). */
function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.trim().split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** `to` expressed relative to the directory `fromDir` (both already normalized). */
function relativeToDir(fromDir: string, to: string): string {
  const from = fromDir ? fromDir.split('/') : [];
  const toSegments = to.split('/');
  let i = 0;
  while (i < from.length && from[i] === toSegments[i]) i++;
  return [...from.slice(i).map(() => '..'), ...toSegments.slice(i)].join('/');
}

/**
 * Workspace path → the path tectonic recorded for it (relative to the root's
 * directory, its cwd), so forward search on `paper/sections/intro.tex` under
 * root `paper/main.tex` asks the index for `sections/intro.tex`, and a file
 * outside that directory for `../shared/macros.tex`.
 */
export function pathRelativeToRoot(rootPath: string, path: string): string {
  return relativeToDir(normalizePath(rootPath.slice(0, rootPath.lastIndexOf('/') + 1)), normalizePath(path));
}

/** Inverse of pathRelativeToRoot: a root-relative input back to its workspace path. */
export function pathFromRoot(rootPath: string, rel: string): string {
  return normalizePath(rootPath.slice(0, rootPath.lastIndexOf('/') + 1) + rel);
}

/** Parse already-decompressed SyncTeX text. Exposed for unit tests + reuse. */
export function parseSyncTexText(text: string): SyncTexIndex {
  const tagToFile = new Map<number, string>();
  // forward: `${tag}:${line}` → first point seen (topmost in reading order).
  const forwardRecords = new Map<string, SyncTexForwardHit>();
  // forward fallback: per tag, the sorted set of lines that have a record.
  const linesByTag = new Map<number, Set<number>>();
  const boxesByPage = new Map<number, Box[]>();
  // Word-level records (glyph/kern/glue/math). Line boxes are tagged with ONE
  // source line even when the paragraph spans several, so box-only inverse
  // search systematically lands early; these points carry the per-word lines.
  const pointsByPage = new Map<number, Point[]>();

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
        list.push({ x, y, w, h, d, file: relToRoot(file), line });
      }
    } else {
      const file = tagToFile.get(tag);
      if (file) {
        let list = pointsByPage.get(page);
        if (!list) {
          list = [];
          pointsByPage.set(page, list);
        }
        list.push({ x, y, file: relToRoot(file), line });
      }
    }
  }

  // Tectonic records each input as `<cwd>/<path as written>` (absolute under
  // the compile pool's build dir), cwd being the root's directory and tag 1 the
  // root itself. Strip that so inputs are keyed by their path relative to the
  // root directory, `..` included — the form pathRelativeToRoot yields for a
  // workspace path. Exact match only, no suffix/basename fallback: a workspace
  // `drafts/sections/intro.tex` that wasn't compiled must not resolve to the
  // compiled `sections/intro.tex`.
  // Both sides are normalized before the comparison: engines record an input
  // either as written (`<cwd>/../shared/macros.tex`) or already resolved, and
  // the two must land on the same key.
  function relToRoot(p: string): string {
    const root = tagToFile.get(1) ?? '';
    return relativeToDir(normalizePath(root.slice(0, root.lastIndexOf('/') + 1)), normalizePath(p));
  }
  function tagFor(file: string): number | null {
    const q = normalizePath(file);
    for (const [tag, path] of tagToFile) {
      if (path && relToRoot(path) === q) return tag;
    }
    return null;
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
      if (!best) return null;
      // Word-level refinement: a line box carries one source line for the whole
      // rendered line, but a paragraph typed across several source lines puts
      // words from later lines on it — the box line then lands lines away. The
      // word points carry the true per-word line, with two decoding rules
      // (verified against real pdflatex output):
      //   1. A record marks the END of its material — the material between two
      //      records belongs to the SECOND one, so the click's owner is the
      //      first record at-or-right-of it, not the nearest.
      //   2. The first record of a rendered line is tagged with the line BOX's
      //      line (the paragraph's break line), not its material's — when it
      //      matches the box tag and a second record exists, trust the second.
      // Whitespace clicks (no baseline within one line-height) keep the box's
      // snap-to-nearest-line behavior.
      const points = pointsByPage.get(page);
      if (points) {
        let lineY: number | null = null;
        let lineVDist = Infinity;
        for (const p of points) {
          const vDist = Math.abs(p.y - yPt);
          if (vDist <= POINT_REFINE_MAX_VDIST_PT && vDist < lineVDist) {
            lineVDist = vDist;
            lineY = p.y;
          }
        }
        if (lineY !== null) {
          const row = points.filter((p) => p.y === lineY).sort((a, b) => a.x - b.x);
          let idx = row.findIndex((p) => p.x >= xPt);
          if (idx === -1) idx = row.length - 1;
          if (idx === 0 && row.length > 1 && row[0].line === best.line && row[0].file === best.file) {
            idx = 1;
          }
          return { file: row[idx].file, line: row[idx].line };
        }
      }
      return { file: best.file, line: best.line };
    },

    forwardSpans(file, startLine, endLine) {
      const target = normalizePath(file);
      const spans: SyncTexSpan[] = [];
      for (const [page, points] of pointsByPage) {
        // Rendered rows share an exact baseline; walk each row in x order and
        // take the end-marker intervals (prev.x, point.x] whose line is in
        // range. The row's first record has no interval (and carries the line
        // box's junk tag anyway — see inverse()).
        const rows = new Map<number, Point[]>();
        for (const p of points) {
          const row = rows.get(p.y);
          if (row) row.push(p);
          else rows.set(p.y, [p]);
        }
        for (const [y, row] of rows) {
          row.sort((a, b) => a.x - b.x);
          let open: { x: number; w: number } | null = null;
          for (let i = 1; i < row.length; i++) {
            const p = row[i];
            const from = row[i - 1].x;
            const inRange =
              p.line >= startLine && p.line <= endLine && normalizePath(p.file) === target;
            if (inRange && p.x > from) {
              if (open && from <= open.x + open.w + 0.5) {
                open.w = p.x - open.x;
              } else {
                if (open) spans.push({ page, x: open.x, y, w: open.w });
                open = { x: from, w: p.x - from };
              }
            }
          }
          if (open) spans.push({ page, x: open.x, y, w: open.w });
        }
      }
      return spans;
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
