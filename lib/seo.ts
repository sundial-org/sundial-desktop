// ============================================================================
// Shared SEO constants & helpers
// ============================================================================

function normalizeSiteUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname === 'sundialhub.com' || parsed.hostname === 'www.sundialhub.com' || parsed.hostname === 'sundial.md') {
      parsed.hostname = 'www.sundial.md';
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return trimmed;
  }
}

export const SITE_URL = normalizeSiteUrl(
  process.env.NEXT_PUBLIC_APP_URL || 'https://www.sundial.md',
);

export const SITE_NAME = 'Sundial';

export const SITE_DESCRIPTION =
  'Sunny is an AI collaborator that lives in iMessage/RCS threads and works inside shared files.';

export const SITE_TAGLINE =
  'Where people and agents do their best work together.';

export const TWITTER_HANDLE = '@sundialhub';

/**
 * Target keywords — used in metadata `keywords` arrays.
 */
export const KEYWORDS = [
  'ai workspace',
  'imessage ai agent',
  'rcs ai agent',
  'collaborative ai workspace',
  'ai document editing',
  'persistent ai agent',
  'agent workspace',
  'github ai agent',
];

/** Canonical URL builder — strips trailing slashes */
export function canonicalUrl(path = ''): string {
  const clean = path.replace(/\/+$/, '');
  return `${SITE_URL}${clean}`;
}

/** Common OG image dimensions */
export const OG_IMAGE_SIZE = { width: 1200, height: 630 };

/** Default OG image URL — the dynamically generated root card (`app/opengraph-image.tsx`). */
export const DEFAULT_OG_IMAGE = `${SITE_URL}/opengraph-image`;
