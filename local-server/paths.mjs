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

/** Policy matcher, with unsafe/empty paths treated as ignored. */
export function isIgnoredPath(rel) {
  const normalized = normalizeRelPath(rel);
  if (!normalized) return true;
  return policyIsIgnoredPath(normalized);
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
