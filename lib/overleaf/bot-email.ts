// The Overleaf bot identity users invite, per environment: one Overleaf
// account cannot serve two environments (their invite polls would race), so
// dev runs dev@sundial.md and prod runs sync@sundial.md.
//
// Resolution order: explicit NEXT_PUBLIC_OVERLEAF_BOT_EMAIL wins; otherwise
// derive from the runtime host (client) or NEXT_PUBLIC_APP_URL (server). Only
// the real prod host gets the prod bot; staging, dev, localhost, and previews
// all fall back to the dev bot so they never race prod's invite polls.

export function overleafBotEmail(): string {
  const explicit = process.env.NEXT_PUBLIC_OVERLEAF_BOT_EMAIL?.trim();
  if (explicit) return explicit;
  const host =
    typeof window !== 'undefined'
      ? window.location.hostname
      : (() => {
          try {
            return new URL(process.env.NEXT_PUBLIC_APP_URL ?? '').hostname;
          } catch {
            return '';
          }
        })();
  return host === 'sundial.md' || host === 'www.sundial.md' ? 'sync@sundial.md' : 'dev@sundial.md';
}
