const BASE_MS = 2_000;
const CAP_MS = 5 * 60_000;

/** Exponential backoff with jitter (50-100% of the step). `attempt` starts at 1. */
export function backoffMs(attempt: number, random: () => number, retryAfterMs?: number): number {
  const step = Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, attempt - 1));
  const jittered = step * (0.5 + random() * 0.5);
  return Math.max(jittered, retryAfterMs ?? 0);
}
