export const SUNNY_AVATARS = [
  '/sunnies/sundial-default.png',
  '/sunnies/sunny-sunglasses.png',
  '/sunnies/sunny-wizard.png',
  '/sunnies/sunny-headphones.png',
  '/sunnies/sunny-nerd.png',
  '/sunnies/sunny-crown.png',
  '/sunnies/sunny-beanie.png',
  '/sunnies/sunny-tongue.png',
  '/sunnies/sunny-grad.png',
  '/sunnies/sunny-party.png',
] as const;

type ChatLike = { id: string; sunny_number?: number | null };

export const DEFAULT_SUNNY_AVATAR = SUNNY_AVATARS[0];

/**
 * Build a {chatId -> avatar path} map keyed off the globally-unique
 * sunny_number. A chat's avatar is determined entirely by its Sunny number,
 * so creating a new chat never reshuffles any existing chat's image — the
 * new chat just takes the next slot in the rotation.
 *
 * Drafts (no sunny_number yet) fall back to the default avatar until the
 * promotion lands and populates their number.
 */
export function buildSunnyAvatarMap(chats: ChatLike[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const chat of chats) {
    const n = chat.sunny_number;
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
      map.set(chat.id, SUNNY_AVATARS[(n - 1) % SUNNY_AVATARS.length]);
    } else {
      map.set(chat.id, DEFAULT_SUNNY_AVATAR);
    }
  }
  return map;
}
