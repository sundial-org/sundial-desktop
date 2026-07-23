// Minimal glob matcher for scoping workspace file listings (GET /files?glob=).
// Patterns match the FULL workspace-relative path, anchored. Supports:
//   *   any run of chars except '/'  (one path segment)
//   **  any run of chars including '/' (spans directories)
//   ?   a single char except '/'
// Everything else is matched literally. Case-sensitive, like file paths.
// Intentionally tiny — we don't pull in picomatch for a handful of features.

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++; // consume the second '*'
        if (glob[i + 1] === '/') {
          // `a/**/b` should also match `a/b`, so the slash is optional.
          re += '(?:.*/)?';
          i++;
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.*+?^${}()|\[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

/**
 * The literal directory prefix before the first wildcard, e.g. `src/app/**` →
 * `src/app/`. Pushed to PostgREST as `.like('<prefix>%')` so glob scoping never
 * scans the whole table — only the JS glob filter narrows further. Returns ''
 * when the pattern starts with a wildcard (e.g. `*.ts`, or a leading `**`).
 */
export function globLiteralPrefix(glob: string): string {
  const wild = glob.search(/[*?]/);
  const head = wild === -1 ? glob : glob.slice(0, wild);
  const slash = head.lastIndexOf('/');
  return slash === -1 ? '' : head.slice(0, slash + 1);
}
