import path from 'node:path';

import { isIgnoredPath as policyIsIgnoredPath, policy } from '../lib/crdt-js/sync_policy.mjs';

const TEXT_EXTS = new Set(policy.crdt_extensions ?? []);
const BLOB_EXTS = new Set(policy.blob_extensions ?? []);

/** Normalize a project-relative path: forward slashes, no leading slash,
 *  no empty/dot segments. Returns null for unsafe paths (absolute, `..`). */
export function normalizeRelPath(rel) {
  if (typeof rel !== 'string') return null;
  const segments = rel
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0 && s !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;
  return segments.join('/');
}

/** Absolute path for a project-relative path, or null if it escapes root. */
export function resolveInRoot(root, rel) {
  const normalized = normalizeRelPath(rel);
  if (!normalized) return null;
  const abs = path.resolve(root, normalized);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/** Env-secret files stay local: `.env` and `.env.*` hold credentials, and a
 *  folder share must never quietly ship them to the cloud (nor clobber the
 *  local copy with a cloud one). The template shapes people DO want synced
 *  (`.env.example` and friends) stay eligible. Sidecar-only judgment — the
 *  shared policy is untouched, so workspace-side .env files (HTTP rail,
 *  sandbox hydration) keep working exactly as before. */
export function isEnvSecretPath(rel) {
  const normalized = normalizeRelPath(rel);
  if (!normalized) return false;
  const base = normalized.split('/').pop() ?? '';
  if (base === '.env') return true;
  return base.startsWith('.env.') && !/\.(example|sample|template|test)$/.test(base);
}

/** Why a cloud path cannot be written on a Windows filesystem, or null when
 *  it can. Used to SKIP such downloads loudly instead of erroring on every
 *  poll (reserved device names, forbidden characters, trailing dot/space). */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export function windowsUnwritableReason(rel) {
  const normalized = normalizeRelPath(rel);
  if (!normalized) return 'unsafe path';
  for (const segment of normalized.split('/')) {
    // eslint-disable-next-line no-control-regex
    if (/[<>:"|?*\u0000-\u001f]/.test(segment)) return `"${segment}" contains characters Windows forbids`;
    if (WINDOWS_RESERVED_NAMES.test(segment.split('.')[0] ?? '')) return `"${segment}" is a reserved Windows device name`;
    if (/[. ]$/.test(segment)) return `"${segment}" ends with a dot or space`;
  }
  return null;
}

/** Policy matcher, with unsafe/empty paths treated as ignored. Env-secret
 *  files are ignored HERE (both sync directions pass through this) on top
 *  of the shared policy list. */
export function isIgnoredPath(rel) {
  const normalized = normalizeRelPath(rel);
  if (!normalized) return true;
  if (isEnvSecretPath(normalized)) return true;
  return policyIsIgnoredPath(normalized);
}

/** Does one grants-model share scope cover this path? ('chat' scopes never
 *  cover files; a 'project' scope covers everything.) */
export function scopeCoversPath(scope, rel) {
  if (scope.scope_kind === 'chat') return false;
  if (scope.scope_kind === 'project' || !scope.scope_path) return true;
  if (scope.scope_kind === 'file') return rel === scope.scope_path;
  return rel === scope.scope_path || rel.startsWith(`${scope.scope_path}/`);
}

export function fileKind(rel) {
  const match = rel.toLowerCase().match(/\.[^./]+$/);
  const ext = match ? match[0] : '';
  if (TEXT_EXTS.has(ext)) return 'text';
  if (BLOB_EXTS.has(ext)) return 'blob';
  return null;
}

/** Serving/upload content types by extension (shared by the HTTP server and
 *  the share bridge's blob uploads). */
export const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
};

export function mimeFor(rel) {
  return MIME[path.extname(rel).toLowerCase()] ?? null;
}
