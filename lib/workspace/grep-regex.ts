// Models emit PCRE/ripgrep word-boundary escapes (`\b`, `\B`), but in Postgres
// ARE `\b` is the *backspace* char — `\bgetUser\b` would match nothing. Rewrite
// them to ARE's boundary escapes (`\y`, `\Y`). Respect `\\` (escaped backslash)
// and bracket expressions, where `\b` is a literal backspace, not a boundary.
//
// NOTE: kept byte-for-byte in sync with agent-ts/src/tools/grep.ts (Sunny's
// Grep tool). The two packages have separate build roots and can't share a
// module without restructuring agent-ts's tsc rootDir; tests/api/grep-regex
// and agent-ts/tests/grep-tool guard the same vectors on both sides.
export function toPostgresRegex(pattern: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1]!;
      if (!inClass && next === 'b') out += '\\y';
      else if (!inClass && next === 'B') out += '\\Y';
      else out += c + next; // keep \\ and every other escape intact
      i++;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    out += c;
  }
  return out;
}
