import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import { api, errText, qk, type IndexerSummary } from "@/api";
import { firstLine, runQueue } from "@/pages/indexers/logic";
import { needsInput, type AddItem, type AddStatus } from "@/pages/indexers/selection";

/**
 * Adds several catalog trackers one by one: trackers whose default config needs no
 * input are saved as is (saving = adding); the rest are marked "setup" for the config dialog.
 */
export function useBulkAdd() {
  const qc = useQueryClient();
  const [items, setItems] = useState<AddItem[] | null>(null);
  const [running, setRunning] = useState(false);
  const stop = useRef(false);

  const setStatus = useCallback((id: string, status: AddStatus, error?: string) => {
    setItems((prev) => prev?.map((it) => (it.id === id ? { ...it, status, error } : it)) ?? prev);
  }, []);

  const start = useCallback(
    async (list: IndexerSummary[]) => {
      if (list.length === 0) return;
      stop.current = false;
      setItems(list.map((ix) => ({ id: ix.id, name: ix.name, status: "pending" })));
      setRunning(true);
      let added = 0;
      await runQueue(
        list,
        async (ix) => {
          setStatus(ix.id, "running");
          try {
            const fields = await api.indexerConfig(ix.id);
            if (needsInput(fields, ix.type)) {
              setStatus(ix.id, "setup");
              return;
            }
            // Complete field list, unchanged: Jackett saves the defaults and the tracker becomes configured.
            await api.saveIndexerConfig(ix.id, fields);
            added++;
            setStatus(ix.id, "added");
          } catch (err) {
            setStatus(ix.id, "failed", firstLine(errText(err), 300));
          }
        },
        { concurrency: 1, shouldStop: () => stop.current },
      );
      setItems((prev) => prev?.map((it) => (it.status === "pending" ? { ...it, status: "skipped" } : it)) ?? prev);
      setRunning(false);
      if (added > 0) void qc.invalidateQueries({ queryKey: qk.indexers });
    },
    [qc, setStatus],
  );

  return {
    items,
    running,
    start,
    stop: () => (stop.current = true),
    setStatus,
    reset: () => setItems(null),
  };
}
