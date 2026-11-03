import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, RefreshCw, Search, X } from "lucide-react";
import { useMemo, useState } from "react";

import { api, qk } from "@/api";
import { CopyButton, EmptyState, ErrorState, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton, Switch } from "@/components/ui/misc";
import { formatDateTime, relativeTime } from "@/lib/format";
import { useDebounced, useLocalState, useNow } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { countByLevel, filterRows, LEVELS, type LevelFilter, type LogLevel, type LogRow, toRows } from "@/pages/logs/logic";

const PAGE = 200;

const LEVEL_STYLE: Record<LogLevel, { label: string; className: string }> = {
  error: { label: "Error", className: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300" },
  warn: { label: "Warn", className: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300" },
  info: { label: "Info", className: "border-sky-500/30 bg-sky-500/10 text-sky-800 dark:text-sky-300" },
  debug: { label: "Debug", className: "border-border bg-muted text-muted-foreground" },
};

function LevelBadge({ level }: { level: LogLevel }) {
  const s = LEVEL_STYLE[level];
  return (
    <span className={cn("inline-flex w-14 shrink-0 justify-center rounded border px-1.5 py-0.5 text-[11px] font-semibold", s.className)}>
      {s.label}
    </span>
  );
}

function LogItem({ row, now }: { row: LogRow; now: number }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className={cn("border-b last:border-b-0", row.level === "error" && "bg-red-500/[0.03]")}>
      <button
        type="button"
        className="flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Chevron
          className={cn("mt-0.5 h-4 w-4 shrink-0 text-muted-foreground", !row.multiline && !open && "opacity-30")}
          aria-hidden
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-start sm:gap-3">
          <div className="flex shrink-0 items-center gap-2 sm:w-64">
            <LevelBadge level={row.level} />
            <time dateTime={row.when} className="text-xs text-muted-foreground" title={formatDateTime(row.when)}>
              <span className="tabular-nums">{formatDateTime(row.when)}</span>
              <span className="hidden md:inline"> · {relativeTime(row.when, now)}</span>
            </time>
          </div>
          <span className={cn("min-w-0 flex-1 text-sm", open ? "break-words" : "truncate")}>
            {row.firstLine || <span className="text-muted-foreground">(пусто)</span>}
            {row.multiline && !open && <span className="ml-1 text-xs text-muted-foreground">…</span>}
          </span>
        </div>
      </button>
      {open && (
        <div className="relative mx-3 mb-3 rounded-md border bg-muted/40">
          <CopyButton value={row.message} label="Копировать сообщение" className="absolute right-1 top-1 bg-background/80" />
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words p-3 pr-10 font-mono text-xs leading-relaxed">
            {row.message}
          </pre>
        </div>
      )}
    </li>
  );
}

export function LogsPage() {
  const [auto, setAuto] = useLocalState("jackett-ui.logs.autoRefresh", false);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const q = useDebounced(query, 200);
  const now = useNow(15_000);

  const logs = useQuery({
    queryKey: qk.logs,
    queryFn: api.logs,
    refetchInterval: auto ? 5_000 : false,
  });

  const rows = useMemo(() => toRows(logs.data ?? []), [logs.data]);
  const counts = useMemo(() => countByLevel(rows), [rows]);
  const visible = useMemo(() => filterRows(rows, level, q), [rows, level, q]);

  return (
    <div className="min-w-0">
      <PageHeader
        title="Журнал"
        description="Последние сообщения Jackett, новые сверху."
        actions={
          <>
            <div className="flex items-center gap-2">
              <Switch id="logs-auto" checked={auto} onCheckedChange={setAuto} />
              <Label htmlFor="logs-auto" className="cursor-pointer text-sm font-normal">
                Обновлять каждые 5 с
              </Label>
            </div>
            <Button variant="outline" size="sm" onClick={() => logs.refetch()} disabled={logs.isFetching}>
              <RefreshCw className={cn(logs.isFetching && "animate-spin")} />
              Обновить
            </Button>
          </>
        }
      />

      <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center">
        <div role="group" aria-label="Уровень" className="flex flex-wrap gap-1.5">
          {LEVELS.map((l) => (
            <button
              key={l.value}
              type="button"
              aria-pressed={level === l.value}
              onClick={() => {
                setLevel(l.value);
                setLimit(PAGE);
              }}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                level === l.value ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-accent",
              )}
            >
              {l.label}
              <span className={cn("tabular-nums", level === l.value ? "opacity-80" : "text-muted-foreground")}>{counts[l.value]}</span>
            </button>
          ))}
        </div>
        <div className="relative md:ml-auto md:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            aria-label="Поиск по сообщениям"
            placeholder="Поиск по тексту"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(PAGE);
            }}
            className="pl-8"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        {logs.isPending ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : logs.isError && !logs.data ? (
          <ErrorState error={logs.error} onRetry={() => logs.refetch()} />
        ) : visible.length === 0 ? (
          <EmptyState
            title={rows.length === 0 ? "Журнал пуст" : "Ничего не найдено"}
            description={rows.length === 0 ? undefined : "Измените фильтр или поисковый запрос."}
            action={
              rows.length > 0 && (level !== "all" || query) ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setLevel("all");
                    setQuery("");
                  }}
                >
                  <X />
                  Сбросить фильтр
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <ul aria-label="Сообщения журнала">
              {visible.slice(0, limit).map((r) => (
                <LogItem key={r.id} row={r} now={now} />
              ))}
            </ul>
            {visible.length > limit && (
              <div className="border-t p-2 text-center">
                <Button variant="ghost" size="sm" onClick={() => setLimit(limit + PAGE)}>
                  Показать ещё ({visible.length - limit})
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
