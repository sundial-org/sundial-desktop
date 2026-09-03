/**
 * The caller's IP as seen by the edge.
 *
 * First hop of `x-forwarded-for`, the address the edge recorded; later hops
 * can carry whatever the client sent. Meaningful only behind a proxy that
 * rewrites the header (ours does), and never an identity: use it as one weak
 * key among others, and expect NATs to share it.
 */
export function clientIpFromRequest(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  if (first) return first;
  return request.headers.get('x-real-ip')?.trim() || null;
}
