/* ── Factcheck: claim schema shared by route and popup ────────────────
 *  A factcheck runs one research-capable model pass over a selected passage
 *  and returns per-claim findings with sources. `quote` is an EXACT
 *  substring of the checked passage — the popup both highlights it in the
 *  editor and applies `correction` over it, so the contract is load-bearing
 *  (the route drops any claim whose quote doesn't match). Client-safe.
 * ─────────────────────────────────────────────────────────────────── */

export type FactcheckVerdict = 'inaccurate' | 'unsupported' | 'accurate';

export type FactcheckClaim = {
  /** Exact contiguous substring of the checked passage. */
  quote: string;
  verdict: FactcheckVerdict;
  /** Replacement for `quote` that fixes the inaccuracy; null when there is
   *  nothing to correct (accurate / genuinely unverifiable). */
  correction: string | null;
  explanation: string;
  confidence: 'high' | 'medium' | 'low';
  /** 1-based indices into the response's `sources`. */
  sources: number[];
};

export type FactcheckSource = { url: string; title: string | null };

export type FactcheckResponse = {
  claims: FactcheckClaim[];
  sources: FactcheckSource[];
};

export const MAX_FACTCHECK_TEXT_CHARS = 12000;

/** Parse the model's JSON (possibly fenced / with prose around it) into
 *  claims, dropping anything malformed or whose quote isn't an exact
 *  substring of the passage. Exported for tests. */
export function parseFactcheckClaims(raw: string, passage: string): FactcheckClaim[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  const claims = (parsed as { claims?: unknown }).claims;
  if (!Array.isArray(claims)) return [];
  const valid: FactcheckClaim[] = [];
  for (const claim of claims) {
    if (typeof claim !== 'object' || claim === null) continue;
    const c = claim as Record<string, unknown>;
    const quote = typeof c.quote === 'string' ? c.quote : '';
    const verdict = c.verdict;
    if (!quote || !passage.includes(quote)) continue;
    if (verdict !== 'inaccurate' && verdict !== 'unsupported' && verdict !== 'accurate') continue;
    valid.push({
      quote,
      verdict,
      correction:
        typeof c.correction === 'string' && c.correction.trim() && c.correction !== quote
          ? c.correction
          : null,
      explanation: typeof c.explanation === 'string' ? c.explanation : '',
      confidence: c.confidence === 'high' || c.confidence === 'low' ? c.confidence : 'medium',
      sources: Array.isArray(c.sources)
        ? c.sources.filter((n): n is number => Number.isInteger(n) && (n as number) > 0)
        : [],
    });
  }
  return valid;
}
