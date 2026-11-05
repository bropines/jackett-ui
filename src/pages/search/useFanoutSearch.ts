import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { api, type SearchResponse } from "@/api";

import { mergeTrackers, TRACKER_TIMEOUT_MS, trackerErrorText, withTimeout, type MergedSearch, type TrackerState } from "./fanout";

type Answer = { ok: true; data: SearchResponse } | { ok: false; error: string; elapsed: number };

const STALE = 5 * 60_000;

export const searchKey = (q: string, id: string, c: string) => ["search", q, id, c] as const;

/**
 * Searches each tracker with its own request (see fanout.ts). Failed trackers are cached
 * as answers, so a retry asks again only when the user says so.
 */
export function useFanoutSearch({
  query,
  trackers,
  categories,
  enabled,
  timeoutMs = TRACKER_TIMEOUT_MS,
}: {
  query: string;
  /** Trackers to ask: `{id, name}`. */
  trackers: { id: string; name: string }[];
  categories: number[];
  enabled: boolean;
  /** How long to wait for one tracker. */
  timeoutMs?: number;
}) {
  const qc = useQueryClient();
  const c = categories.join(",");

  const results = useQueries({
    queries: trackers.map((t) => ({
      queryKey: searchKey(query, t.id, c),
      enabled: enabled && query !== "",
      staleTime: STALE,
      retry: false,
      queryFn: async ({ signal }): Promise<Answer> => {
        const started = Date.now();
        try {
          const data = await withTimeout(signal, timeoutMs, (s) => api.search({ query, categories }, t.id, s));
          return { ok: true, data };
        } catch (err) {
          if (signal.aborted) throw err; // cancelled by the user: not an answer
          return { ok: false, error: trackerErrorText(err), elapsed: Date.now() - started };
        }
      },
    })),
  });

  const states: TrackerState[] = trackers.map((t, i) => {
    const r = results[i];
    const a = r?.data;
    if (a?.ok) return { ...t, status: "done", data: a.data };
    if (a && !a.ok) return { ...t, status: "error", error: a.error, elapsed: a.elapsed };
    if (r?.isError) return { ...t, status: "error", error: trackerErrorText(r.error), elapsed: 0 };
    if (r?.isFetching) return { ...t, status: "pending" };
    return { ...t, status: "cancelled" };
  });
  // Re-merge only when an answer changes.
  const sig = states.map((s) => s.status + (s.status === "done" ? results[trackers.findIndex((t) => t.id === s.id)]?.dataUpdatedAt : "")).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const merged: MergedSearch = useMemo(() => mergeTrackers(states), [sig, trackers]);

  const fetching = results.some((r) => r.isFetching);
  const cancelledCount = states.filter((s) => s.status === "cancelled").length;

  const cancel = useCallback(() => void qc.cancelQueries({ queryKey: ["search", query] }), [qc, query]);
  const refetch = useCallback(
    () => Promise.all(trackers.map((t) => qc.refetchQueries({ queryKey: searchKey(query, t.id, c), exact: true }))),
    [qc, trackers, query, c],
  );

  return {
    ...merged,
    fetching,
    answered: trackers.length - merged.pending.length - cancelledCount,
    total: trackers.length,
    cancelledCount,
    cancel,
    refetch,
  };
}
