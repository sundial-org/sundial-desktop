// Which agent a NEW chat runs on when nobody has picked one. There is no
// upfront chooser: on the desktop app we use whichever local engine the
// machine already has (Claude Code first, then Codex — both run on the user's
// own subscription), and everything else runs the Sundial Agent. The composer
// chip shows the result, so the pick stays visible and changeable per chat.

import type { ChatHarness } from './chat-runtime';

export type EngineState = { available: boolean; loggedIn: boolean };
/** null = no sidecar (web), so no local engine can run here. */
export type LocalEngineDetection = { claude: EngineState; codex: EngineState } | null;

/** An engine is usable only when it's installed AND logged in — a binary
 *  without a session fails the very first turn. */
export function engineDetected(engine: EngineState | null | undefined): boolean {
  return Boolean(engine?.available && engine?.loggedIn);
}

export function resolveDefaultHarness(detection: LocalEngineDetection): ChatHarness {
  if (engineDetected(detection?.claude)) return 'claude';
  if (engineDetected(detection?.codex)) return 'openai';
  return 'vercel';
}

/** What a resolved default may be STAMPED on a chat row. The implicit cloud
 *  fallback stays null: a row stamped 'vercel' could never follow a local
 *  engine the user installs later, because adoption only touches null rows.
 *  An explicit pick is passed straight through by its caller. */
export function stampableHarness(harness: ChatHarness | null | undefined): ChatHarness | null {
  return harness && harness !== 'vercel' ? harness : null;
}
