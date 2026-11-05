import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { ArrowDown, ArrowDownWideNarrow, ArrowUp, ArrowUpDown, ArrowUpNarrowWide, Filter, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EmptyState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, formatNumber, relativeTime } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { cn } from "@/lib/utils";

import {
  defaultDesc,
  filterRows,
  formatSize,
  SEED_TONE_CLASS,
  seedTone,
  sortRows,
  SORT_LABELS,
  type ResultRow,
  type SortKey,
} from "./logic";
import { PosterThumb } from "./preview/Poster";
import { ResultPreview } from "./preview/ResultPreview";
import { ResultActions } from "./ResultActions";
import { useMediaQuery } from "./useMediaQuery";

const PAGE = 100;

interface Meta {
  className?: string;
}

function TrackerTag({ name }: { name: string }) {
  return <span className="inline-flex max-w-[12rem] truncate rounded border bg-muted/50 px-1.5 text-[11px] leading-5 text-muted-foreground">{name}</span>;
}

function Seeds({ n, className }: { n: number | null; className?: string }) {
  return <span className={cn("font-medium tabular-nums", SEED_TONE_CLASS[seedTone(n)], className)}>{n ?? "—"}</span>;
}

function Published({ row, now }: { row: ResultRow; now: number }) {
  if (row.published == null) return <span className="text-muted-foreground">—</span>;
  return (
    <time dateTime={row.r.PublishDate} title={formatDateTime(row.r.PublishDate)} className="whitespace-nowrap">
      {relativeTime(row.r.PublishDate, now)}
    </time>
  );
}

/** Title as a button that opens the preview. */
function TitleButton({ row, onPreview, className }: { row: ResultRow; onPreview: (row: ResultRow) => void; className?: string }) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      className={cn(
        "break-words rounded-sm text-left leading-snug [overflow-wrap:anywhere] hover:text-primary hover:underline hover:underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      onClick={() => onPreview(row)}
    >
      {row.r.Title}
    </button>
  );
}

function useColumns(now: number, onPreview: (row: ResultRow) => void): ColumnDef<ResultRow>[] {
  return useMemo<ColumnDef<ResultRow>[]>(
    () => [
      {
        id: "title",
        header: "Название",
        sortDescFirst: false,
        meta: { className: "min-w-[14rem]" } satisfies Meta,
        cell: ({ row: { original: row } }) => (
          <div className="flex min-w-0 items-start gap-2.5">
            <PosterThumb src={row.r.Poster} className="-my-0.5" />
            <div className="min-w-0">
              <TitleButton row={row} onPreview={onPreview} />
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground xl:hidden">
                <TrackerTag name={row.r.Tracker} />
                {row.category && <span>{row.category}</span>}
              </div>
            </div>
          </div>
        ),
      },
      {
        id: "tracker",
        header: "Трекер",
        sortDescFirst: false,
        meta: { className: "hidden xl:table-cell whitespace-nowrap" } satisfies Meta,
        cell: ({ row: { original: row } }) => <TrackerTag name={row.r.Tracker} />,
      },
      {
        id: "category",
        header: "Категория",
        sortDescFirst: false,
        meta: { className: "hidden xl:table-cell max-w-[10rem] text-muted-foreground" } satisfies Meta,
        cell: ({ row: { original: row } }) => <span className="line-clamp-2">{row.category || "—"}</span>,
      },
      {
        id: "size",
        header: "Размер",
        sortDescFirst: true,
        meta: { className: "whitespace-nowrap text-right tabular-nums" } satisfies Meta,
        cell: ({ row: { original: row } }) => formatSize(row.r.Size),
      },
      {
        id: "seeders",
        header: "Сиды",
        sortDescFirst: true,
        meta: { className: "whitespace-nowrap text-right" } satisfies Meta,
        cell: ({ row: { original: row } }) => <Seeds n={row.r.Seeders} />,
      },
      {
        id: "peers",
        header: "Пиры",
        sortDescFirst: true,
        meta: { className: "hidden lg:table-cell whitespace-nowrap text-right tabular-nums text-muted-foreground" } satisfies Meta,
        cell: ({ row: { original: row } }) => row.r.Peers ?? "—",
      },
      {
        id: "published",
        header: "Дата",
        sortDescFirst: true,
        meta: { className: "whitespace-nowrap text-muted-foreground" } satisfies Meta,
        cell: ({ row: { original: row } }) => <Published row={row} now={now} />,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Действия</span>,
        enableSorting: false,
        meta: { className: "w-0 whitespace-nowrap pr-2" } satisfies Meta,
        cell: ({ row: { original: row } }) => <ResultActions r={row.r} onPreview={() => onPreview(row)} />,
      },
    ],
    [now, onPreview],
  );
}

/** Mobile sort control (no column headers there). */
function MobileSort({ sort, onChange }: { sort: { id: SortKey; desc: boolean }; onChange: (s: { id: SortKey; desc: boolean }) => void }) {
  return (
    <div className="flex items-center gap-1">
      <Select value={sort.id} onValueChange={(v) => onChange({ id: v as SortKey, desc: defaultDesc(v as SortKey) })}>
        <SelectTrigger className="h-9 w-[8.5rem]" aria-label="Сортировка">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
            <SelectItem key={k} value={k}>
              {SORT_LABELS[k]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        size="icon"
        onClick={() => onChange({ ...sort, desc: !sort.desc })}
        aria-label={sort.desc ? "По убыванию" : "По возрастанию"}
        title={sort.desc ? "По убыванию" : "По возрастанию"}
      >
        {sort.desc ? <ArrowDownWideNarrow /> : <ArrowUpNarrowWide />}
      </Button>
    </div>
  );
}

function ResultCard({ row, now, onPreview }: { row: ResultRow; now: number; onPreview: (row: ResultRow) => void }) {
  const r = row.r;
  return (
    <li className="rounded-lg border bg-card p-3">
      <div className="flex min-w-0 items-start gap-3">
        <PosterThumb src={r.Poster} />
        <div className="min-w-0 flex-1">
          <TitleButton row={row} onPreview={onPreview} className="text-sm font-medium" />
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <TrackerTag name={r.Tracker} />
            {row.category && <span className="truncate">{row.category}</span>}
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-3 text-xs">
        <span className="tabular-nums">{formatSize(r.Size)}</span>
        <span className="inline-flex items-center gap-1" title="Сиды / пиры">
          <ArrowUp className="h-3 w-3 text-muted-foreground" aria-hidden />
          <Seeds n={r.Seeders} />
          <span className="text-muted-foreground">/ {r.Peers ?? "—"}</span>
        </span>
        <span className="min-w-0 truncate text-muted-foreground">
          <Published row={row} now={now} />
        </span>
        <ResultActions r={r} onPreview={() => onPreview(row)} className="-my-1 ml-auto" />
      </div>
    </li>
  );
}

/** Loads the next page when the sentinel scrolls into view (button fallback without IntersectionObserver). */
function MoreSentinel({ onMore }: { onMore: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onMore);
  cb.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && cb.current(), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} aria-hidden />;
}

/**
 * Results list: client-side filter + sort, table on ≥ md, cards below.
 * Renders PAGE rows at a time and grows on scroll so 1000+ results stay fast.
 */
export const ResultsView = memo(function ResultsView({
  rows,
  dimmed,
  only,
  onOnly,
}: {
  rows: ResultRow[];
  dimmed?: boolean;
  /** Client-side "only this tracker" filter (set from the indexer strip). */
  only: string | null;
  onOnly: (id: string | null) => void;
}) {
  const now = useNow(60_000);
  const desktop = useMediaQuery("(min-width: 768px)");
  const [filter, setFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([{ id: "seeders", desc: true }]);
  const sort = { id: (sorting[0]?.id ?? "seeders") as SortKey, desc: sorting[0]?.desc ?? true };

  const visible = useMemo(() => sortRows(filterRows(rows, filter, only), sort.id, sort.desc), [rows, filter, only, sort.id, sort.desc]);

  // Reset paging whenever the list itself changes.
  const listKey = `${rows.length}|${rows[0]?.id}|${filter}|${only}|${sort.id}|${sort.desc}`;
  const [paging, setPaging] = useState({ key: listKey, limit: PAGE });
  const limit = paging.key === listKey ? paging.limit : PAGE;
  const more = () => setPaging({ key: listKey, limit: limit + PAGE });
  // Stable array: the table treats a new `data` array as new data (see autoResetPageIndex below).
  const page = useMemo(() => visible.slice(0, limit), [visible, limit]);

  // Preview panel: the row stays set while the close animation runs.
  const [preview, setPreview] = useState<{ row: ResultRow | null; open: boolean }>({ row: null, open: false });
  const openPreview = useCallback((row: ResultRow) => setPreview({ row, open: true }), []);

  const columns = useColumns(now, openPreview);
  const table = useReactTable({
    data: page,
    columns,
    getRowId: (r) => r.id,
    state: { sorting },
    onSortingChange: setSorting,
    manualSorting: true,
    // No pagination model here. Left on, every new `data` queued a page reset that changed the
    // table state, re-rendered this view with a fresh slice and looped (the tab hung with a preview open).
    autoResetAll: false,
    enableSortingRemoval: false,
    enableMultiSort: false,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className={cn("space-y-2 transition-opacity", dimmed && "pointer-events-none opacity-50")} aria-busy={dimmed}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Filter className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setFilter("")}
            placeholder="Фильтр: 1080p -cam"
            aria-label="Фильтр результатов"
            className="h-9 pl-8 pr-8"
          />
          {filter && (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setFilter("")}
              aria-label="Очистить фильтр"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {!desktop && <MobileSort sort={sort} onChange={(s) => setSorting([s])} />}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {visible.length === rows.length ? formatNumber(rows.length) : `${formatNumber(visible.length)} из ${formatNumber(rows.length)}`}
        </span>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            title="Нет совпадений"
            description="Фильтр скрыл все результаты."
            action={
              <Button variant="outline" size="sm" onClick={() => {
                  setFilter("");
                  onOnly(null);
                }}>
                Сбросить фильтр
              </Button>
            }
          />
        </div>
      ) : desktop ? (
        <div className="rounded-lg border bg-card">
          <Table className="text-[0.8125rem]">
            <TableHeader className="bg-muted/40">
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id} className="hover:bg-transparent">
                  {hg.headers.map((h) => {
                    const meta = h.column.columnDef.meta as Meta | undefined;
                    const sorted = h.column.getIsSorted();
                    return (
                      <TableHead
                        key={h.id}
                        className={cn("h-9 px-3", meta?.className)}
                        aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                      >
                        {h.column.getCanSort() ? (
                          <button
                            type="button"
                            className={cn(
                              "-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                              sorted && "text-foreground",
                            )}
                            onClick={h.column.getToggleSortingHandler()}
                          >
                            {flexRender(h.column.columnDef.header, h.getContext())}
                            {sorted === "asc" ? (
                              <ArrowUp className="h-3.5 w-3.5" />
                            ) : sorted === "desc" ? (
                              <ArrowDown className="h-3.5 w-3.5" />
                            ) : (
                              <ArrowUpDown className="h-3.5 w-3.5 opacity-40" />
                            )}
                          </button>
                        ) : (
                          flexRender(h.column.columnDef.header, h.getContext())
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta as Meta | undefined;
                    return (
                      <TableCell key={cell.id} className={cn("px-3 py-1.5", meta?.className)}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <ul className="space-y-2">
          {page.map((row) => (
            <ResultCard key={row.id} row={row} now={now} onPreview={openPreview} />
          ))}
        </ul>
      )}

      {limit < visible.length && (
        <div className="flex flex-col items-center gap-2 py-2">
          <MoreSentinel key={limit} onMore={more} />
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={more}>
              Показать ещё
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPaging({ key: listKey, limit: visible.length })}>
              Все ({formatNumber(visible.length)})
            </Button>
          </div>
        </div>
      )}

      <ResultPreview row={preview.row} open={preview.open} onOpenChange={(open) => setPreview((p) => ({ ...p, open }))} />
    </div>
  );
});
