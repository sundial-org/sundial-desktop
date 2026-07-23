type AgentStatus = 'idle' | 'working' | 'done' | 'error' | 'starting' | 'stopped' | undefined;

type SessionDurationInput = {
  status: AgentStatus;
  totalRuntimeSeconds?: number | null;
  runStartedAt?: string | null;
  nowMs?: number;
};

const parseTimestampMs = (value: string | null | undefined): number => {
  if (!value) return Number.NaN;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

export function computeSessionDurationSeconds({
  status,
  totalRuntimeSeconds,
  runStartedAt,
  nowMs = Date.now(),
}: SessionDurationInput): number | null {
  const baseSeconds =
    typeof totalRuntimeSeconds === 'number' && Number.isFinite(totalRuntimeSeconds)
      ? Math.max(0, Math.floor(totalRuntimeSeconds))
      : 0;
  const isRunning = status === 'working' || status === 'starting';
  if (!isRunning) {
    return baseSeconds > 0 ? baseSeconds : null;
  }

  const startMs = parseTimestampMs(runStartedAt);
  if (!Number.isFinite(startMs)) {
    return baseSeconds > 0 ? baseSeconds : null;
  }

  const liveElapsedSeconds = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  return baseSeconds + liveElapsedSeconds;
}
