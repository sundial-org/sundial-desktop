/**
 * Which audience a build/deployment serves. One codebase, two flavors:
 *
 * - 'scientific' — the LaTeX-first edition: welcome.tex onboarding with the
 *   compile-error tour, research featured skills.
 * - 'general'    — the markdown-first product (desktop/OSS, and the general
 *   web deployment): welcome.md onboarding, general featured skills.
 *
 * Resolution for a visitor, highest priority first:
 *   1. `?flavor=` on the request being served (only /new sets it, and it also
 *      lands in a cookie so the choice survives the redirect chain).
 *   2. The `sundial_flavor` cookie (1 year), so a visitor who arrived from the
 *      LaTeX marketing page keeps the scientific edition afterwards.
 *   3. The env default below.
 *
 * Env default is 'scientific' so existing deployments never change behavior by
 * omission. A web deployment opts in with NEXT_PUBLIC_SUNDIAL_FLAVOR=general
 * (client + server) or SUNDIAL_FLAVOR=general (server only) — a DEFAULT, which
 * a visitor's cookie still overrides on every surface.
 *
 * The desktop-ui build instead PINS its flavor (desktop-ui/next.config.ts sets
 * NEXT_PUBLIC_SUNDIAL_FLAVOR_PINNED=1 beside it): a pin is not a default, so
 * no cookie the webview happens to carry can flip the desktop to the LaTeX
 * edition. Setting the flavor without the pin flag stays a default, which is
 * what keeps per-visitor overrides working on the general web deployment.
 */
export type ProductFlavor = 'scientific' | 'general';

/** Cookie holding a visitor's chosen flavor (set by /new?flavor=…). */
export const FLAVOR_COOKIE_NAME = 'sundial_flavor';
/** Query param that chooses a flavor and plants the cookie. */
export const FLAVOR_QUERY_PARAM = 'flavor';
export const FLAVOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function parseFlavor(raw: string | null | undefined): ProductFlavor | null {
  return raw === 'general' || raw === 'scientific' ? raw : null;
}

/** The deployment default: what a request with no cookie and no param gets. */
export function productFlavor(): ProductFlavor {
  const raw = process.env.NEXT_PUBLIC_SUNDIAL_FLAVOR ?? process.env.SUNDIAL_FLAVOR;
  return raw === 'general' ? 'general' : 'scientific';
}

/**
 * Build-time pin: only the desktop-ui build sets the PINNED flag, and only a
 * pin outranks the visitor's cookie. A web deployment's
 * NEXT_PUBLIC_SUNDIAL_FLAVOR is a default, not a pin.
 */
function pinnedFlavor(): ProductFlavor | null {
  return process.env.NEXT_PUBLIC_SUNDIAL_FLAVOR_PINNED === '1'
    ? parseFlavor(process.env.NEXT_PUBLIC_SUNDIAL_FLAVOR)
    : null;
}

/** Query beats cookie beats env default. */
export function resolveFlavor(input: {
  cookie?: string | null;
  query?: string | null;
}): ProductFlavor {
  return parseFlavor(input.query) ?? parseFlavor(input.cookie) ?? productFlavor();
}

/** Read the flavor cookie out of a `Cookie:` header or `document.cookie`. */
export function readFlavorCookie(header: string | null | undefined): ProductFlavor | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== FLAVOR_COOKIE_NAME) continue;
    return parseFlavor(part.slice(eq + 1).trim());
  }
  return null;
}

/** Request-aware resolution for server components (Next's `headers()`). */
export function flavorFromHeaders(
  requestHeaders: Headers,
  query?: string | null,
): ProductFlavor {
  return resolveFlavor({ query, cookie: readFlavorCookie(requestHeaders.get('cookie')) });
}

/** Request-aware resolution for route handlers (cookie header + ?flavor=). */
export function flavorFromRequest(request: Request): ProductFlavor {
  let query: string | null = null;
  try {
    query = new URL(request.url).searchParams.get(FLAVOR_QUERY_PARAM);
  } catch {
    // Relative/opaque URL in tests — cookie and env still resolve.
  }
  return resolveFlavor({ query, cookie: readFlavorCookie(request.headers.get('cookie')) });
}

/**
 * Browser-side resolution. A build pin wins first so the pinned desktop build
 * can never be flipped by a cookie; otherwise the visitor's cookie wins over
 * the deployment default. Safe on the server (no document → env default), so
 * isomorphic callers can use it as a fallback and pass the request-resolved
 * flavor when they have one.
 */
export function clientFlavor(): ProductFlavor {
  const pinned = pinnedFlavor();
  if (pinned) return pinned;
  if (typeof document === 'undefined') return productFlavor();
  return resolveFlavor({ cookie: readFlavorCookie(document.cookie) });
}
