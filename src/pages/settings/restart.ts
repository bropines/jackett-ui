/** Waiting for Jackett to come back after a restart (proxy changes trigger one). */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  isCancelled?: () => boolean;
  wait?: (ms: number) => Promise<void>;
}

/**
 * Calls `probe` every `intervalMs` (first call after one interval) until it resolves,
 * `timeoutMs` passes or `isCancelled()` turns true. Returns the probe result or null.
 */
export async function pollUntilUp<T>(
  probe: () => Promise<T>,
  { intervalMs = 2_000, timeoutMs = 30_000, isCancelled = () => false, wait = sleep }: PollOptions = {},
): Promise<T | null> {
  const attempts = Math.max(1, Math.floor(timeoutMs / intervalMs));
  for (let i = 0; i < attempts; i++) {
    await wait(intervalMs);
    if (isCancelled()) return null;
    try {
      return await probe();
    } catch {
      /* still restarting */
    }
  }
  return null;
}
