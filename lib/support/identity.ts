import { ANON_COOKIE_NAME, generateAnonId, isValidAnonId } from '@/lib/auth/anon-identity';

export type SupportActor = {
  actorKey: string;
  userId: string | null;
  anonId: string | null;
  previousAnonId: string | null;
  shouldSetAnonCookie: boolean;
};

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get('cookie') ?? '';
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function resolveSupportActor(request: Request, userId: string | null): SupportActor {
  const existing = cookieValue(request, ANON_COOKIE_NAME);
  if (userId) {
    return {
      actorKey: `user:${userId}`,
      userId,
      anonId: null,
      previousAnonId: isValidAnonId(existing) ? existing : null,
      shouldSetAnonCookie: false,
    };
  }
  const anonId = isValidAnonId(existing) ? existing : generateAnonId();
  return {
    actorKey: `anon:${anonId}`,
    userId: null,
    anonId,
    previousAnonId: null,
    shouldSetAnonCookie: !isValidAnonId(existing),
  };
}

export function setSupportActorCookie(response: Response, actor: SupportActor) {
  if (!actor.shouldSetAnonCookie || !actor.anonId) return;
  response.headers.append(
    'Set-Cookie',
    `${ANON_COOKIE_NAME}=${encodeURIComponent(actor.anonId)}; Path=/; Max-Age=31536000; SameSite=Lax`,
  );
}
