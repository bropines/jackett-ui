import { AlertTriangle, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { useState } from "react";

import type { SearchIndexerStatus } from "@/api";
import { CopyButton } from "@/components/common";
import { cn } from "@/lib/utils";

import { firstLine, formatElapsed } from "./logic";

/**
 * Per-tracker outcome of the last search. OK chips toggle a client-side
 * "only this tracker" filter; error chips expand the error text. Trackers still
 * searching are shown last with a spinner.
 */
export function IndexerStrip({
  indexers,
  pending = [],
  only,
  onOnly,
}: {
  indexers: SearchIndexerStatus[];
  pending?: { ID: string; Name: string }[];
  only: string | null;
  onOnly: (id: string | null) => void;
}) {
  const [openError, setOpenError] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  if (indexers.length === 0 && pending.length === 0) return null;

  const sorted = [...indexers].sort((a, b) => (a.Status === 1 ? 0 : 1) - (b.Status === 1 ? 0 : 1) || b.Results - a.Results);
  const failed = indexers.find((i) => i.ID === openError && i.Status === 1);
  const multi = indexers.filter((i) => i.Status !== 1).length > 1;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" aria-label="Трекеры в поиске">
        {sorted.map((i) => {
          const isError = i.Status === 1;
          const active = isError ? openError === i.ID : only === i.ID;
          return (
            <button
              key={i.ID}
              type="button"
              aria-pressed={active}
              disabled={!isError && !multi && only !== i.ID}
              title={isError ? firstLine(i.Error) : multi ? "Показать только этот трекер" : undefined}
              onClick={() => {
                if (isError) {
                  setOpenError(active ? null : i.ID);
                  setFull(false);
                } else onOnly(active ? null : i.ID);
              }}
              className={cn(
                "inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default",
                isError
                  ? "border-red-500/40 bg-red-500/10 text-red-700 hover:bg-red-500/15 dark:text-red-300"
                  : "bg-card hover:bg-accent disabled:hover:bg-card",
                active && !isError && "border-primary bg-primary/10",
                active && isError && "ring-1 ring-red-500/50",
              )}
            >
              {isError ? (
                <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
              ) : (
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", i.Results > 0 ? "bg-emerald-500" : "bg-zinc-400")} aria-hidden />
              )}
              <span className="truncate font-medium">{i.Name}</span>
              {isError ? <span className="sr-only">ошибка</span> : <span className="tabular-nums">{i.Results}</span>}
              <span className="tabular-nums text-muted-foreground">{formatElapsed(i.ElapsedTime)}</span>
            </button>
          );
        })}
        {pending.map((p) => (
          <span
            key={p.ID}
            className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-dashed px-2 py-0.5 text-xs text-muted-foreground"
            title="Ещё ищет"
          >
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
            <span className="truncate">{p.Name}</span>
            <span className="sr-only">ищет</span>
          </span>
        ))}
      </div>
      {failed && (
        <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 p-2 text-xs text-red-800 dark:text-red-200">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <span className="font-medium">{failed.Name}: </span>
              <span className="break-words">{firstLine(failed.Error) || "неизвестная ошибка"}</span>
            </div>
            {failed.Error && <CopyButton value={failed.Error} label="Копировать ошибку" className="h-6 w-6" />}
          </div>
          {failed.Error && failed.Error.trim().includes("\n") && (
            <>
              <button
                type="button"
                className="mt-1 inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                onClick={() => setFull((v) => !v)}
                aria-expanded={full}
              >
                {full ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                {full ? "Скрыть подробности" : "Подробности"}
              </button>
              {full && (
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-2 font-mono text-[11px] text-foreground">
                  {failed.Error}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
