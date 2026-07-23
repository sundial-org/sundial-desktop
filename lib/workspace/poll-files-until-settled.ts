// After a clone, the clone request returns before the sandbox→doc-store mirror
// has landed any files, and realtime drops events on insert bursts — so we poll
// the file list until its count stops growing. The cadence ramps from snappy to
// relaxed: the first cloned files surface in well under a second (instead of up
// to the old flat 4s), while a long multi-minute clone backs off to ~4s polls
// so it doesn't hammer the DB.

export type SettlePollOptions = {
  // Refetch the tree; resolves to the current file count (null/undefined = unknown).
  reload: () => Promise<number | null | undefined>;
  sleep: (ms: number) => Promise<void>;
  // False once a newer poll has superseded this one (or the page unmounted).
  shouldContinue: () => boolean;
  now?: () => number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  growth?: number;
  // Settle only after the count has held steady (and > 0) for this long. This
  // is wall-clock, NOT a poll count — so the fast early polls surface files
  // quickly without letting a brief gap between chunk batches (a slow PostgREST
  // write or a chunk retry) be mistaken for "done".
  quietMs?: number;
  deadlineMs?: number;
};

export async function pollFilesUntilSettled(opts: SettlePollOptions): Promise<void> {
  const {
    reload,
    sleep,
    shouldContinue,
    now = Date.now,
    initialDelayMs = 600,
    maxDelayMs = 4_000,
    growth = 1.6,
    quietMs = 10_000,
    deadlineMs = 10 * 60 * 1000,
  } = opts;

  let lastCount = -1;
  let lastChangeAt = now();
  let delay = initialDelayMs;
  const deadline = now() + deadlineMs;

  while (now() < deadline && shouldContinue()) {
    const count = await reload().catch(() => null);
    // A failed refetch tells us nothing — leave the streak untouched.
    if (count != null) {
      if (count !== lastCount) {
        lastCount = count;
        lastChangeAt = now();
      } else if (count > 0 && now() - lastChangeAt >= quietMs) {
        return;
      }
    }
    await sleep(delay);
    delay = Math.min(delay * growth, maxDelayMs);
  }
}
