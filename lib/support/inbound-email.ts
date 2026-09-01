const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

export function mailboxAddress(value: string | null | undefined): string {
  const raw = value?.trim() ?? '';
  return (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim().toLowerCase();
}

export function threadIdFromEmail(to: string[], subject: string | null | undefined): string | null {
  for (const address of to) {
    const localPart = mailboxAddress(address).split('@')[0] ?? '';
    const match = localPart.match(/^support\+(.+)$/i)?.[1]?.match(UUID_RE);
    if (match) return match[0].toLowerCase();
  }
  return subject?.match(/\[thread:([0-9a-f-]{36})\]/i)?.[1]?.toLowerCase() ?? null;
}

export function replyInstruction(body: string | null | undefined): string {
  if (!body) return '';
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let cut = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (
      /^\s*>/.test(line) ||
      /^\s*On .+wrote:\s*$/i.test(line) ||
      /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i.test(line) ||
      (/^\s*From:\s/i.test(line) && index > 0)
    ) {
      cut = index;
      break;
    }
  }
  return lines.slice(0, cut).join('\n').trim().slice(0, 8_000);
}

export function plainTextEmail(text: string | null | undefined, html: string | null | undefined): string {
  if (text?.trim()) return text;
  return (html ?? '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

export function senderAuthenticated(
  headers: Record<string, string> | null | undefined,
  fromEmail: string,
): boolean {
  const domain = fromEmail.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  const authentication = Object.entries(headers ?? {})
    .filter(([key]) => /authentication-results/i.test(key))
    .map(([, value]) => value)
    .join('; ')
    .toLowerCase();
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`dmarc=pass[^;]*header\\.from=${escaped}\\b`).test(authentication)
    || new RegExp(`dkim=pass[^;]*(?:header\\.i=@|header\\.d=)${escaped}\\b`).test(authentication);
}
