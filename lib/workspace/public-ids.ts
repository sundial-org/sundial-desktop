const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE62 = BigInt(BASE62_ALPHABET.length);
const BIGINT_ZERO = BigInt(0);
const UUID_HEX_LENGTH = 32;
const LEGACY_WORKSPACE_ID_LENGTH = 22;
const LEGACY_WORKSPACE_ID_REGEX = /^[0-9A-Za-z]{22}$/;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WorkspaceRouteInput =
  | string
  | {
      id: string;
      public_id?: string | null;
      publicId?: string | null;
    };

function encodeBase62(value: bigint) {
  if (value === BIGINT_ZERO) return BASE62_ALPHABET[0];

  let remaining = value;
  let encoded = '';
  while (remaining > BIGINT_ZERO) {
    const index = Number(remaining % BASE62);
    encoded = BASE62_ALPHABET[index] + encoded;
    remaining /= BASE62;
  }
  return encoded;
}

function decodeBase62(value: string) {
  let decoded = BIGINT_ZERO;
  for (const char of value) {
    const index = BASE62_ALPHABET.indexOf(char);
    if (index < 0) {
      return null;
    }
    decoded = decoded * BASE62 + BigInt(index);
  }
  return decoded;
}

function randomBase62(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => BASE62_ALPHABET[byte % BASE62_ALPHABET.length]).join('');
}

export function isUuid(value: string) {
  return UUID_REGEX.test(value.trim());
}

export function encodeLegacyWorkspaceId(workspaceId: string) {
  const trimmed = workspaceId.trim();
  if (!isUuid(trimmed)) {
    return trimmed;
  }

  const hex = trimmed.replaceAll('-', '').toLowerCase();
  const encoded = encodeBase62(BigInt(`0x${hex}`));
  return encoded.padStart(LEGACY_WORKSPACE_ID_LENGTH, BASE62_ALPHABET[0]);
}

export function decodeLegacyWorkspaceId(workspaceIdOrSlug: string) {
  const trimmed = workspaceIdOrSlug.trim();
  if (isUuid(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (!LEGACY_WORKSPACE_ID_REGEX.test(trimmed)) {
    return null;
  }

  const decoded = decodeBase62(trimmed);
  if (decoded === null) {
    return null;
  }

  const hex = decoded.toString(16).padStart(UUID_HEX_LENGTH, '0');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return isUuid(uuid) ? uuid : null;
}

export function resolveWorkspaceId(workspaceIdOrSlug: string) {
  const trimmed = workspaceIdOrSlug.trim();
  return decodeLegacyWorkspaceId(trimmed) ?? trimmed;
}

export function resolveWorkspaceLookup(workspaceIdOrSlug: string) {
  const trimmed = workspaceIdOrSlug.trim();
  const decoded = decodeLegacyWorkspaceId(trimmed);

  if (decoded) {
    return {
      column: 'id' as const,
      value: decoded,
    };
  }

  return {
    column: 'public_id' as const,
    value: trimmed,
  };
}

export function getWorkspaceRouteId(workspace: WorkspaceRouteInput) {
  if (typeof workspace === 'string') {
    const trimmed = workspace.trim();
    return isUuid(trimmed) ? encodeLegacyWorkspaceId(trimmed) : trimmed;
  }

  const publicId = workspace.public_id?.trim() || workspace.publicId?.trim();
  if (publicId) {
    return publicId;
  }

  return encodeLegacyWorkspaceId(workspace.id);
}

export function createShortInviteToken(length = 16) {
  return randomBase62(length);
}

export function createWorkspacePublicId(length = 6) {
  return randomBase62(length);
}

// Git-style short refs for file/chat ids in shareable URLs: links carry the
// first hex group of the UUID and resolvers accept any unambiguous prefix,
// so full-id links keep working forever. Non-UUID ids (e.g. draft chats) are
// never shortened — a truncated one wouldn't resolve.
const SHORT_ID_REF_LENGTH = 8;
const SHORT_ID_REF_MIN_LENGTH = 6;
const SHORT_ID_REF_REGEX = /^[0-9a-f]{6,8}$/i;

export function toShortIdRef(id: string) {
  const trimmed = id.trim();
  return isUuid(trimmed) ? trimmed.slice(0, SHORT_ID_REF_LENGTH) : trimmed;
}

export function isShortIdRef(value: string) {
  return SHORT_ID_REF_REGEX.test(value);
}

export function idMatchesRef(id: string, ref: string) {
  return id === ref || (ref.length >= SHORT_ID_REF_MIN_LENGTH && id.startsWith(ref));
}

export function findIndexByIdRef<T>(
  items: readonly T[],
  ref: string | null | undefined,
  getId: (item: T) => string,
): number {
  const trimmed = ref?.trim();
  if (!trimmed) return -1;
  const allowPrefix = trimmed.length >= SHORT_ID_REF_MIN_LENGTH;
  let prefixIndex = -1;
  let prefixCount = 0;
  for (let i = 0; i < items.length; i += 1) {
    const id = getId(items[i]);
    if (id === trimmed) return i;
    if (allowPrefix && prefixCount < 2 && id.startsWith(trimmed)) {
      prefixIndex = i;
      prefixCount += 1;
    }
  }
  return prefixCount === 1 ? prefixIndex : -1;
}

export function findByIdRef<T>(
  items: readonly T[],
  ref: string | null | undefined,
  getId: (item: T) => string,
): T | null {
  const index = findIndexByIdRef(items, ref, getId);
  return index >= 0 ? items[index] : null;
}
