/**
 * One dedicated compile-fix chat per project. "Fix with Agent" and the
 * auto-fix-on-failure path both send their turns here — never into whatever
 * conversation happens to be open — so real chats stay unpolluted and the
 * fix history reads as one clean audit trail.
 *
 * The chat is marked with `kind = 'latex_fix'` (nullable `chats.kind`,
 * mirrored on the sidecar's `local_chats`), created on first use and reused
 * forever. A deleted (or archived) fix chat simply stops matching, so the
 * next fix creates a fresh one.
 */

export const LATEX_FIX_CHAT_KIND = 'latex_fix';
export const LATEX_FIX_CHAT_TITLE = 'LaTeX fixes';

/** Compile fixes are latency-critical and mechanical (read the log, apply a
 *  minimal edit) — pin the fix chat to Haiku instead of the workspace default
 *  so a fix turn answers in seconds. Same model the free anonymous lane runs
 *  on (ANON_RUN_MODEL_ID). Users can still re-model the chat by hand; only a
 *  model-less fix chat is ever pinned. */
export const LATEX_FIX_CHAT_MODEL = 'anthropic/claude-haiku-4.5';

type FixChatThread = {
  chat: {
    id: string;
    kind?: string | null;
    archived_at?: string | null;
    created_at?: string | null;
    model?: string | null;
  };
};

/** The project's live fix chat, if any. Deterministic across tabs: the OLDEST
 *  active fix chat wins (id tiebreak), so racing creators converge on the same
 *  winner. Archived rows don't match — archiving is the user retiring the
 *  trail, so the next fix starts a new one. */
export function findLatexFixChat(threads: readonly FixChatThread[]): FixChatThread['chat'] | null {
  const live = threads
    .filter((t) => t.chat.kind === LATEX_FIX_CHAT_KIND && !t.chat.archived_at)
    .map((t) => t.chat)
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id));
  return live[0] ?? null;
}

export function findLatexFixChatId(threads: readonly FixChatThread[]): string | null {
  return findLatexFixChat(threads)?.id ?? null;
}

/** Find-or-create. Callers must serialize concurrent invocations in one tab
 *  (share one in-flight promise). Cross-tab races are converged after the
 *  fact: both tabs can pass the refresh before either create commits, so the
 *  post-create re-check keeps the deterministic winner and retires our own
 *  copy when it lost — later fixes in every tab route to the same chat. */
export async function ensureLatexFixChat(args: {
  threads: readonly FixChatThread[];
  refreshThreads: () => Promise<readonly FixChatThread[]>;
  createChat: () => Promise<string | null>;
  archiveChat?: (chatId: string) => Promise<void>;
  /** Pin a pre-existing, still-default fix chat to the fast fix model.
   *  Fire-and-forget: the fix send never waits on (or fails with) it. */
  setChatModel?: (chatId: string) => Promise<void>;
}): Promise<string | null> {
  // A fix chat from before the fast-model pin (model unset = workspace
  // default) gets pinned on reuse; a model the user chose is left alone.
  const adopt = (chat: FixChatThread['chat'] | null): string | null => {
    if (chat && !chat.model && args.setChatModel) void args.setChatModel(chat.id).catch(() => {});
    return chat?.id ?? null;
  };
  const cached = adopt(findLatexFixChat(args.threads));
  if (cached) return cached;
  // Second lookup against server truth before creating — the cached list can
  // lag a fix chat another tab (or an earlier click) just created.
  const refreshed = adopt(findLatexFixChat(await args.refreshThreads().catch(() => [])));
  if (refreshed) return refreshed;
  const created = await args.createChat();
  if (!created) return null;
  const winner = findLatexFixChatId(await args.refreshThreads().catch(() => []));
  if (winner && winner !== created) {
    // Retire our copy, then refresh once more so THIS tab's chat list drops it
    // too — the pre-archive refresh had already pulled both duplicates in.
    await args.archiveChat?.(created).then(() => args.refreshThreads()).catch(() => {});
    return winner;
  }
  return created;
}
