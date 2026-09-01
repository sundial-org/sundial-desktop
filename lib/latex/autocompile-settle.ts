/**
 * "Is the user mid-expression?" heuristic for auto compile (§1.2).
 *
 * An auto compile fired while a construct is still open (`\frac{a`, an
 * unclosed `$`, a dangling `\begin{align}`) is guaranteed red noise: the
 * text cannot compile until the construct closes. So the debounce holds
 * while the document looks unfinished, and releases only when the closing
 * keystroke arrives — no long-idle fallback; the dirty text stays owed and
 * manual compile remains available for a deliberately unfinished document.
 *
 * Runs at most once per debounce expiry (never per keystroke — the editor
 * keystroke path stays O(change)), on the full text. One linear pass.
 */

export type LatexSettleHold = 'open-math' | 'open-group' | 'open-env';

const VERBATIM_ENVS = new Set(['verbatim', 'verbatim*', 'lstlisting', 'minted', 'comment']);

const envNameAt = (text: string, index: number): string | null => {
  // index points at the char after "\begin" / "\end"; expect "{name}".
  if (text[index] !== '{') return null;
  const close = text.indexOf('}', index + 1);
  if (close === -1 || close - index > 64) return null;
  return text.slice(index + 1, close);
};

/**
 * Null when the text looks complete enough to compile; otherwise the first
 * kind of construct found still open. Escapes (`\$`, `\{`, `\%`, `\\`) and
 * `%` comments are honored; verbatim-like environments are skipped wholesale.
 * Plain-text false positives (a raw `$` price in prose) merely defer the auto
 * compile until the next edit or a manual compile — they were compile errors
 * anyway.
 */
export function latexSettleHold(text: string): LatexSettleHold | null {
  let braceDepth = 0;
  let inlineMath = false; // toggled by unescaped `$`
  let displayMath = false; // toggled by unescaped `$$`
  let parenMath = 0; // \( … \)
  let bracketMath = 0; // \[ … \]
  const envStack: string[] = [];
  let verbatimUntil: string | null = null; // inside \begin{verbatim…}: skip until \end{…}

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      if (verbatimUntil !== null) {
        // Only the matching \end{…} matters inside verbatim.
        if (text.startsWith('end', i + 1)) {
          const name = envNameAt(text, i + 4);
          if (name === verbatimUntil) {
            verbatimUntil = null;
            envStack.pop();
            i += 4 + name.length + 1;
            continue;
          }
        }
        continue;
      }
      if (next === '(') parenMath += 1;
      else if (next === ')') parenMath = Math.max(0, parenMath - 1);
      else if (next === '[') bracketMath += 1;
      else if (next === ']') bracketMath = Math.max(0, bracketMath - 1);
      else if (text.startsWith('begin', i + 1)) {
        const name = envNameAt(text, i + 6);
        if (name !== null) {
          envStack.push(name);
          if (VERBATIM_ENVS.has(name)) verbatimUntil = name;
          i += 6 + name.length + 1;
          continue;
        }
      } else if (text.startsWith('end', i + 1)) {
        const name = envNameAt(text, i + 4);
        if (name !== null) {
          // Pop the innermost matching open (tolerates interleaving noise).
          const at = envStack.lastIndexOf(name);
          if (at !== -1) envStack.splice(at, 1);
          i += 4 + name.length + 1;
          continue;
        }
      }
      i += 1; // consume the escaped char (`\$`, `\{`, `\%`, `\\`, …)
      continue;
    }
    if (verbatimUntil !== null) continue;
    if (ch === '%') {
      const eol = text.indexOf('\n', i);
      i = eol === -1 ? text.length : eol;
      continue;
    }
    if (ch === '{') braceDepth += 1;
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === '$') {
      if (text[i + 1] === '$') {
        displayMath = !displayMath;
        i += 1;
      } else {
        inlineMath = !inlineMath;
      }
    }
  }

  if (inlineMath || displayMath || parenMath > 0 || bracketMath > 0) return 'open-math';
  if (envStack.length > 0) return 'open-env';
  if (braceDepth > 0) return 'open-group';
  return null;
}
