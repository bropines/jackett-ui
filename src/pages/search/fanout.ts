import { ApiError, type SearchIndexerStatus, type SearchResponse, type SearchResult } from "@/api";

/**
 * Each tracker is searched with its own request. A proxy in front (Cloudflare) cuts a
 * response after 100 s, and `indexers/all` waits for the slowest tracker, so one slow
 * tracker used to fail the whole search. Per-tracker requests show results as they
 * come and turn a slow tracker into one failed chip.
 */
export const TRACKER_TIMEOUT_MS = 90_000;

/** Choices for "how long to wait for one tracker", seconds. Cloudflare cuts at 100 s anyway. */
export const TIMEOUT_CHOICES = [15, 30, 60, 90] as const;

/** A stored choice, or the default when it is missing or odd. */
export function timeoutSeconds(v: unknown): number {
  return typeof v === "number" && (TIMEOUT_CHOICES as readonly number[]).includes(v) ? v : TRACKER_TIMEOUT_MS / 1000;
}

export type TrackerState =
  | { id: string; name: string; status: "pending" }
  | { id: string; name: string; status: "done"; data: SearchResponse }
  | { id: string; name: string; status: "error"; error: string; elapsed: number }
  | { id: string; name: string; status: "cancelled" };

/** Raised when a tracker did not answer within TRACKER_TIMEOUT_MS. */
export class TrackerTimeout extends Error {
  constructor(public readonly ms: number) {
    super(`Не ответил за ${Math.round(ms / 1000)} с`);
  }
}

/** Short Russian text for a failed per-tracker request. */
export function trackerErrorText(err: unknown): string {
  if (err instanceof TrackerTimeout) return err.message;
  if (err instanceof ApiError) {
    const m = err.message ?? "";
    if (err.status === 524 || /error code:?\s*524/i.test(m)) return "Не ответил за 100 с (обрыв на Cloudflare)";
    if (err.status === 502 || err.status === 504) return `Нет ответа от сервера (HTTP ${err.status})`;
    return m || `HTTP ${err.status}`;
  }
  if (err instanceof TypeError) return "Соединение оборвалось";
  return err instanceof Error ? err.message : String(err);
}

export interface MergedSearch {
  Results: SearchResult[];
  /** Answered trackers (OK or error), in the order they were asked. */
  Indexers: SearchIndexerStatus[];
  /** Still searching. */
  pending: { ID: string; Name: string }[];
  /** At least one tracker answered (with results or an error). */
  any: boolean;
}

/** Merges per-tracker answers into one search response. */
export function mergeTrackers(states: TrackerState[]): MergedSearch {
  const Results: SearchResult[] = [];
  const Indexers: SearchIndexerStatus[] = [];
  const pending: { ID: string; Name: string }[] = [];
  for (const s of states) {
    switch (s.status) {
      case "pending":
        pending.push({ ID: s.id, Name: s.name });
        break;
      case "done": {
        Results.push(...s.data.Results);
        const own = s.data.Indexers.length > 0 ? s.data.Indexers : [{ ID: s.id, Name: s.name, Status: 2, Results: s.data.Results.length, Error: null, ElapsedTime: 0 }];
        Indexers.push(...own);
        break;
      }
      case "error":
        Indexers.push({ ID: s.id, Name: s.name, Status: 1, Results: 0, Error: s.error, ElapsedTime: s.elapsed });
        break;
      case "cancelled":
        break;
    }
  }
  return { Results, Indexers, pending, any: Indexers.length > 0 };
}

/**
 * Runs `fn` with a signal that aborts on `outer` or after `ms`; a timeout becomes TrackerTimeout.
 */
export async function withTimeout<T>(outer: AbortSignal | undefined, ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, ms);
  const onAbort = () => ctl.abort();
  outer?.addEventListener("abort", onAbort);
  try {
    return await fn(ctl.signal);
  } catch (err) {
    if (timedOut) throw new TrackerTimeout(ms);
    throw err;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}
