/**
 * The query fragment that deep-links a share's target: FILE grants land on the
 * document, CHAT grants on the conversation. ONE format for every lane —
 * share links and invite-email redirects must agree on `filePath=`/`chatId=`
 * (the workspace arrival treats both as explicit intent).
 */
export function shareTargetQuery(target: {
  scopeKind?: string | null;
  path?: string | null;
  chatId?: string | null;
}): string {
  if (target.scopeKind === 'file' && target.path) {
    return `filePath=${encodeURIComponent(target.path)}`;
  }
  if (target.chatId) return `chatId=${encodeURIComponent(target.chatId)}`;
  return '';
}
