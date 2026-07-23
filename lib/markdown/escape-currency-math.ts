/**
 * Streamdown's remark-math treats every `$…$` as inline math. A chat message
 * like "Customer A ($750/mo) … log-odds → $\\sigma(-6.3) \\approx 0.18\\%$"
 * therefore lets the currency `$750` open a math span that swallows the prose
 * and unbalances the real `$…$` — so the genuine math leaks as raw `$\sigma…$`
 * (issue #660).
 *
 * We escape only a `$` that begins a *currency amount*: a number (with optional
 * thousands/decimals) terminated by a non-math boundary — `) , ;`, a unit slash
 * (`/` before a letter, as in `$750/mo`), sentence punctuation (`. ! ? :` not
 * continuing a number/math), a range dash before another `$` (`$5-$10`),
 * end-of-line, or whitespace followed by a letter (`$5 million`). That kills
 * `$750/mo`, `$2.50/mo`, `$750.`, `$5!`, `$5-$10` and `$5 per seat` while
 * leaving real inline math intact, including STEM math that starts with a digit
 * like `$3x^2$`, `$3.14$`, `$5^{10}$`, `$1/2$`, `$5-3$`, `$5 + 3$`,
 * `$10 \\times n$` or the factorial `$5!$` (the digits run into a letter,
 * operator, fraction slash, decimal, or the closing `$` — never a currency
 * boundary). Code (fenced or inline) is never touched, where a literal `\$`
 * would render with a visible backslash, nor an already-escaped `\$` or `$$`
 * block math.
 */
const CURRENCY_DOLLAR =
  /(?<![\\$])\$(?=\d[\d,]*(?:\.\d+)?(?:[),;]|\/(?=[A-Za-z])|\.(?!\d)|[!?:](?=\s|$)|-(?=\$)|\s+[A-Za-z]|$))/g;

const escapeOutsideCode = (text: string): string =>
  text.replace(CURRENCY_DOLLAR, "\\$");

/**
 * Replace currency `$` outside inline-code spans. Walks the line so multi-tick
 * code (`` ``echo `$5` `` ``) — where a backtick run opens and closes on a run
 * of the *same* length (CommonMark) — is skipped verbatim, not split on the
 * first inner backtick.
 */
function escapeLineOutsideCode(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      let j = i;
      while (j < line.length && line[j] !== "`") j += 1;
      out += escapeOutsideCode(line.slice(i, j));
      i = j;
      continue;
    }
    // Opening backtick run of length n; a code span closes on a run of exactly n.
    let n = 0;
    while (line[i + n] === "`") n += 1;
    let j = i + n;
    let close = -1;
    while (j < line.length) {
      if (line[j] === "`") {
        let m = 0;
        while (line[j + m] === "`") m += 1;
        if (m === n) {
          close = j;
          break;
        }
        j += m;
      } else {
        j += 1;
      }
    }
    if (close === -1) {
      // Unterminated run: the backticks are literal text, keep scanning after them.
      out += line.slice(i, i + n);
      i += n;
    } else {
      out += line.slice(i, close + n); // code span, verbatim
      i = close + n;
    }
  }
  return out;
}

export function escapeCurrencyMath(markdown: string): string {
  if (!markdown.includes("$")) return markdown;

  // Track the open fence's char + length so a nested fence (e.g. an inner
  // ``` inside an outer ````md block) doesn't prematurely flip the state and
  // expose code lines to escaping. A fence closes only on the same char at
  // length >= the opener (CommonMark).
  let fence: { char: string; len: number } | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
      if (marker) {
        const [char, len] = [marker[0], marker.length];
        if (fence) {
          if (char === fence.char && len >= fence.len) fence = null;
        } else {
          fence = { char, len };
        }
        return line;
      }
      if (fence) return line;
      return escapeLineOutsideCode(line);
    })
    .join("\n");
}
