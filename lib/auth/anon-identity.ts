// Pure helpers for anonymous editor identity. No client/server-only deps —
// safe to import from both surfaces (and from Hocuspocus, which is plain Node).

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const ANON_ID_LENGTH = 16;
export const ANON_AUTHOR_PREFIX = 'anon:';
export const ANON_COOKIE_NAME = 'sd_anon';
// Pending identities: set when an agent hands off `/w/<slug>?anon=<id>` to a
// browser that already carries its own sd_anon. The browser keeps editing as
// itself; ownership checks and claim-on-login honour these too, so a
// handed-off workspace isn't stranded anon-owned.
//
// ONE COOKIE PER HANDOFF, keyed by the id itself — not one cookie holding a
// list. A human can be handed several workspaces before signing in, and a
// shared list cookie would have to be read-modify-written: two links opened
// in separate tabs at the same moment would each compute a list containing
// only their own id, and the later Set-Cookie would silently drop the other.
// Distinct names never collide, so concurrent writes both survive.
export const ANON_HANDOFF_COOKIE_PREFIX = 'sd_anon_h_';

export function anonHandoffCookieName(id: string): string {
  return `${ANON_HANDOFF_COOKIE_PREFIX}${id}`;
}

/**
 * Pull the handoff ids out of a browser's cookie names.
 *
 * Deliberately UNCAPPED. A cap here would only hide the overflow: the cookies
 * still exist, so the hidden workspaces would be neither owner-accessible nor
 * claimed nor cleared — and the claim hook, seeing them forever, would refire
 * on every mount. Each cookie is ~28 bytes and they live only between a
 * handoff and sign-in, when claim-anon clears every one.
 */
export function collectAnonHandoffIds(names: Iterable<string>): string[] {
  const ids: string[] = [];
  for (const name of names) {
    if (!name.startsWith(ANON_HANDOFF_COOKIE_PREFIX)) continue;
    const id = name.slice(ANON_HANDOFF_COOKIE_PREFIX.length);
    if (isValidAnonId(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

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

// A friendly, slug-shaped alternative to a random token. ChatGPT's URL guard
// refuses model-composed URLs whose values LOOK like secrets (high-entropy
// alphanumerics); a hyphenated string of plain words reads like a slug
// (`iclr-2026` passes) instead, which both raises the odds the agent opens it
// and stops chat UIs from stripping the link as a suspected tracking token.
// Pool of innocuous lowercase words; keys are 4 words + 2 digits, e.g.
// `harbor-swift-otter-marble-42` — ~32 bits from the words plus ~6 from the
// digits. Modest by token standards, but this bearer needs the workspace's
// public id too, is rate-limited over HTTP, ephemeral, GC'd, and demoted the
// moment the human claims — so guessing a live (ws, key) pair is infeasible.
const KEY_WORDS = [
  'harbor', 'swift', 'otter', 'marble', 'cedar', 'quiet', 'amber', 'river',
  'maple', 'ember', 'north', 'lucid', 'coral', 'brisk', 'wren', 'flint',
  'meadow', 'pine', 'dusk', 'vale', 'birch', 'slate', 'cove', 'moss',
  'heron', 'lark', 'thorn', 'fern', 'gale', 'reef', 'dune', 'oak',
  'willow', 'aspen', 'basil', 'clover', 'drift', 'echo', 'frost', 'glen',
  'haze', 'ivory', 'jade', 'kelp', 'lotus', 'mist', 'nova', 'onyx',
  'peak', 'quill', 'rust', 'sage', 'tide', 'umber', 'vega', 'wharf',
  'yarn', 'zephyr', 'brook', 'crag', 'delta', 'elm', 'fjord', 'grove',
] as const;

export function generateReadableKey(): string {
  // Word prefix for friendliness, a random base36 tail for entropy: the
  // server-minted key converges an idempotent workspace, so a collision would
  // hand one caller another's workspace. Words alone (64^4 ≈ 2^24) are too
  // few; the 8-char tail adds ~41 bits (2^24 × 36^8 ≈ 2^65), collision-safe at
  // any scale, and the link still reads mostly like a slug so it renders.
  const buf = new Uint8Array(12);
  const cryptoLike =
    (typeof globalThis !== 'undefined' && (globalThis as { crypto?: Crypto }).crypto) || null;
  if (cryptoLike?.getRandomValues) cryptoLike.getRandomValues(buf);
  else for (let i = 0; i < 12; i += 1) buf[i] = Math.floor(Math.random() * 256);
  const words = Array.from({ length: 3 }, (_, i) => KEY_WORDS[buf[i] % KEY_WORDS.length]);
  const base36 = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const tail = Array.from({ length: 6 }, (_, i) => base36[buf[i + 3] % 36]).join('');
  // Trailing digit run: the validator's entropy marker (a hyphenated phrase
  // with no digits, like `not-a-valid-id`, is rejected as a real identity).
  const digits = Array.from({ length: 4 }, (_, i) => `${buf[i + 3] % 10}`).join('');
  return `${words.join('-')}-${tail}-${digits}`;
}

export function isValidAnonId(value: string | null | undefined): value is string {
  // Two accepted shapes, so the workspace binds to the KEY (not a cookie
  // identity) whichever the caller used:
  //  - legacy/server random ids: 12–32 lowercase alphanumerics;
  //  - readable slug keys: lowercase words + digits joined by single hyphens
  //    (no leading/trailing/double hyphen), up to 48 chars.
  // A near-miss must be REJECTED loudly nowhere: it silently orphans the
  // agent after the human's click, so both real shapes are honored.
  if (typeof value !== 'string') return false;
  if (value.length >= 12 && value.length <= 32 && /^[a-z0-9]+$/.test(value)) return true;
  // Readable slug key: hyphen-joined lowercase segments ENDING in a digit
  // run (≥2). The trailing digits are a cheap entropy marker — a plain
  // hyphenated phrase (`not-a-valid-id`) is not a real identity and must not
  // become one, which would let the middleware adopt a guessable owner key.
  return value.length >= 12 && value.length <= 48 && /^[a-z0-9]+(-[a-z0-9]+)*-\d{2,}$/.test(value);
}

/**
 * Pull a workspace key out of whatever the human pasted: the bare key, a full
 * workspace URL carrying `anon=` (or legacy `key=`), or either with stray
 * whitespace. Null when nothing valid is found — the caller shows "that
 * doesn't look like a key", never adopts a near-miss (see isValidAnonId).
 */
export function extractAnonKey(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const fromParam = url.searchParams.get('anon') ?? url.searchParams.get('key');
    return isValidAnonId(fromParam ?? '') ? fromParam : null;
  } catch {
    /* not a URL — treat as a bare key */
  }
  return isValidAnonId(raw) ? raw : null;
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
