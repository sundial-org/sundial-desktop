// Pure helpers for anonymous editor identity. No client/server-only deps —
// safe to import from both surfaces (and from Hocuspocus, which is plain Node).

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const ANON_ID_LENGTH = 16;
export const ANON_AUTHOR_PREFIX = 'anon:';
export const ANON_COOKIE_NAME = 'sd_anon';

// Fixed pool of 64 distinct animals. The list is frozen — changing it would
// rename existing anon authors, breaking attribution continuity.
const ANIMALS = [
  'Otter', 'Badger', 'Panda', 'Falcon', 'Hedgehog', 'Salamander', 'Marmot', 'Heron',
  'Lemur', 'Mongoose', 'Pangolin', 'Wombat', 'Capybara', 'Narwhal', 'Axolotl', 'Quokka',
  'Tapir', 'Okapi', 'Caracal', 'Serval', 'Fennec', 'Coyote', 'Bobcat', 'Civet',
  'Genet', 'Margay', 'Ocelot', 'Jaguarundi', 'Kinkajou', 'Coati', 'Tayra', 'Olingo',
  'Numbat', 'Bilby', 'Quoll', 'Bandicoot', 'Macaque', 'Tarsier', 'Gibbon', 'Loris',
  'Indri', 'Sifaka', 'Galago', 'Echidna', 'Platypus', 'Wallaby', 'Dingo', 'Cassowary',
  'Kiwi', 'Kakapo', 'Kea', 'Takahe', 'Bittern', 'Avocet', 'Stilt', 'Plover',
  'Curlew', 'Godwit', 'Sandpiper', 'Snipe', 'Petrel', 'Albatross', 'Frigate', 'Puffin',
] as const;

export function generateAnonId(): string {
  const buf = new Uint8Array(ANON_ID_LENGTH);
  const cryptoLike =
    (typeof globalThis !== 'undefined' && (globalThis as { crypto?: Crypto }).crypto) || null;
  if (cryptoLike?.getRandomValues) cryptoLike.getRandomValues(buf);
  else for (let i = 0; i < ANON_ID_LENGTH; i += 1) buf[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (let i = 0; i < ANON_ID_LENGTH; i += 1) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}

export function isValidAnonId(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length === ANON_ID_LENGTH && /^[a-z0-9]+$/.test(value);
}

export function toAnonAuthorId(rawId: string): string {
  return `${ANON_AUTHOR_PREFIX}${rawId}`;
}

export function isAnonAuthorId(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.startsWith(ANON_AUTHOR_PREFIX);
}

export function rawAnonId(authorId: string): string {
  return authorId.startsWith(ANON_AUTHOR_PREFIX)
    ? authorId.slice(ANON_AUTHOR_PREFIX.length)
    : authorId;
}

// FNV-1a 32-bit. Stable across runtimes and string inputs — only used to
// pick a fun name slot, no security claim.
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

export function anonDisplayName(authorIdOrRaw: string): string {
  const raw = rawAnonId(authorIdOrRaw);
  const animal = ANIMALS[fnv1a(raw) % ANIMALS.length];
  return `Anonymous ${animal}`;
}
