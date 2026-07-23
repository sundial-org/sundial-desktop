import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const policyPath = path.resolve(__dirname, '../../lib/sync/policy.json');
export const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
const markdownExtensions = new Set(policy.markdown_extensions || []);

export function getExtension(value) {
  if (typeof value !== 'string') return '';
  const match = value.trim().toLowerCase().match(/\.[^./]+$/);
  return match ? match[0] : '';
}

export function isMarkdownFile(value) {
  return markdownExtensions.has(getExtension(value));
}

// Canonical ignore matcher for plain-ESM consumers (the desktop sidecar) —
// same semantics as lib/sync/policy.ts isIgnoredPath, which TS callers use.
// tests/local/paths.test.ts guards the parity.
export function isIgnoredPath(value) {
  const normalized = String(value ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  if (!normalized || normalized === '.') return false;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return false;
  return (policy.ignored_paths || []).some((pattern) => {
    if (!pattern) return false;
    if (pattern.endsWith('/')) return parts.includes(pattern.slice(0, -1));
    if (pattern.startsWith('*.')) return normalized.toLowerCase().endsWith(pattern.slice(1).toLowerCase());
    return parts.includes(pattern) || normalized === pattern;
  });
}
