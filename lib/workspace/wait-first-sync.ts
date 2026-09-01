'use client';

// Client-side wait for a bridge's FIRST sync cycle: polls the linked-repos
// list until the worker persists bridge_state (its updatedAt flips non-null).
// Both repo-link flows show the CloneProgress animation over this wait, so the
// user lands in a populated workspace instead of watching files trickle in.
//
// A timeout resolves (not rejects): the sync keeps running server-side, and
// stranding the user in a spinner for a huge repo is worse than opening the
// workspace while it fills. A recorded first-cycle error rejects.

export async function waitForFirstSync(
  projectId: string,
  repositoryId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  type RepoRow = {
    id: string;
    bridgeState: { updatedAt: string | null; lastError: string | null } | null;
  };

  while (Date.now() < deadline) {
    let repo: RepoRow | undefined;
    try {
      const res = await fetch(
        `/api/workspace/linked-repos?projectId=${encodeURIComponent(projectId)}`,
        { cache: 'no-store', credentials: 'include' },
      );
      const body = (await res.json().catch(() => null)) as { repositories?: RepoRow[] } | null;
      repo = body?.repositories?.find((r) => r.id === repositoryId);
    } catch {
      // transient fetch hiccup: keep polling
    }
    if (repo?.bridgeState?.updatedAt) {
      if (repo.bridgeState.lastError) throw new Error(repo.bridgeState.lastError);
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
