/**
 * Inline diff used by the History modal's preview pane. Renders every line
 * of the after-text and interleaves the deletions where they happened.
 *
 * Algorithm: longest-common-subsequence on lines. Workspace docs are at most
 * a few thousand lines, so an O(N*M) table is plenty.
 */

export type InlineDiffLine = {
  type: 'unchanged' | 'added' | 'removed';
  text: string;
};

export function buildInlineDiff(beforeText: string, afterText: string): InlineDiffLine[] {
  // Treat empty string as zero lines (`''.split('\n')` returns `['']` — splice
  // that out so an empty-before is rendered as pure additions).
  const before = beforeText === '' ? [] : beforeText.split('\n');
  const after = afterText === '' ? [] : afterText.split('\n');
  if (before.length === 0 && after.length === 0) return [];

  const n = before.length;
  const m = after.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (before[i] === after[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const lines: InlineDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      lines.push({ type: 'unchanged', text: before[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: 'removed', text: before[i] });
      i += 1;
    } else {
      lines.push({ type: 'added', text: after[j] });
      j += 1;
    }
  }
  while (i < n) lines.push({ type: 'removed', text: before[i++] });
  while (j < m) lines.push({ type: 'added', text: after[j++] });
  return lines;
}
