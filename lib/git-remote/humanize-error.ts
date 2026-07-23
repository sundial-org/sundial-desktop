import type { LinkedRepoProvider } from '@/lib/workspace/api-shared-types';

// Turn raw git/transport errors into something a human can act on.
// Overleaf's git-bridge returns 403 to free accounts trying to clone — surface
// that explicitly because the underlying message is just `error: 403`.
export function humanizeGitError(provider: LinkedRepoProvider, raw: string): string {
  const text = (raw ?? '').trim();
  if (!text) return 'Unknown git error.';

  if (provider === 'overleaf') {
    if (/\b403\b/.test(text)) {
      return 'Overleaf returned 403. Git integration is a premium-only feature — the Overleaf account whose token you connected needs a paid subscription (or Overleaf Commons via .edu). Check Menu → Sync → Git inside the project on overleaf.com to confirm git-bridge is enabled for that account.';
    }
    if (/not found|\b404\b/i.test(text)) {
      return "Overleaf couldn't find that project. Double-check the project URL and make sure the connected Overleaf account has access to it.";
    }
    if (/\b401\b|authentication failed|invalid (?:username|password|credentials)/i.test(text)) {
      return 'Overleaf rejected the token. Re-paste your token in Settings → Overleaf (tokens look like `olp_…`).';
    }
  }

  if (provider === 'github') {
    if (/\b403\b/.test(text)) {
      return "GitHub denied access (403). The connected GitHub account doesn't have permission for this repo. Try reconnecting GitHub in Settings → GitHub with an account that can write to the repo.";
    }
    if (/\b404\b|not found|repository not found/i.test(text)) {
      return "GitHub couldn't find that repo (404). Check the URL or confirm the connected account has access.";
    }
    if (/\b401\b|bad credentials|invalid (?:username|password|credentials)/i.test(text)) {
      return 'GitHub rejected the token. Reconnect GitHub in Settings → GitHub.';
    }
  }

  return text;
}
