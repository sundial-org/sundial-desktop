// Resolve the URL of the (only) agent harness. The TS harness replaced the
// Python harness; this helper stays so existing callers (e.g. the
// /api/workspace/agent-stream proxy) don't need to know which env var holds
// the URL.

export function tsHarnessUrl(): string | null {
  const explicit = process.env.AGENT_TS_SERVER_URL?.trim() || process.env.AGENT_SERVER_URL?.trim();
  return explicit ? explicit.replace(/\/$/, "") : null;
}
