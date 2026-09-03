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

// Research-lab voice — only the '/' landing (served by the sundial-landing
// repo) and the Organization JSON-LD. Must move together with the landing hero
// (labs/geo-mixed/index.html + the '/' description in scripts/build.mjs, both
// in sundial-landing) — proposals and chosen combo in /labs/og.
export const SITE_DESCRIPTION =
  'Sundial is a research lab studying human-agent collaboration. We build infrastructure for people to understand the work models do, steer them, and shape how they improve.';

export const SITE_TAGLINE = 'Foundations for human-AI collaboration';

// Product voice — every other surface (app pages, /editor, /download, /releases).
// Mirrors the /editor hero; its baked copy lives in the sundial-landing repo.
export const PRODUCT_TAGLINE = 'The multiplayer editor for people and agents';

export const PRODUCT_DESCRIPTION =
  'A local-first collaborative editor where Claude Code, Codex, and hosted agents edit alongside you. Every agent edit arrives as a reviewable suggestion, in live multiplayer markdown, LaTeX, and notebooks.';

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

/** Default OG image URL — the static product card (`app/opengraph-image.png`).
 * The extension matters: bare `/opengraph-image` 404s (caught by the marketing
 * catch-all route). */
export const DEFAULT_OG_IMAGE = `${SITE_URL}/opengraph-image.png`;
