import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useState, type ReactNode } from "react";

import { EmptyState, ErrorState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useSlashFocus } from "@/lib/hooks";
import { cn } from "@/lib/utils";

export interface ColumnMeta {
  className?: string;
}

export interface DataTableProps<T> {
  columns: ColumnDef<T, unknown>[];
  data: T[] | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry?: () => void;
  getRowId: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Client-side search text (matched by `globalFilterFn`). */
  filter?: string;
  globalFilterFn?: (row: T, filter: string) => boolean;
  initialSort?: SortingState;
  empty?: ReactNode;
  rowClassName?: (row: T) => string | undefined;
  pageSize?: number;
}

/**
 * Data table in the RD Panel style (rounded card, muted header, sortable columns,
 * keyboard row navigation). dnsgate lists are small, so sorting, filtering and
 * paging happen on the client.
 */
export function DataTable<T>(props: DataTableProps<T>) {
  const { columns, data, isLoading, error, pageSize = 50 } = props;
  const [sorting, setSorting] = useState<SortingState>(props.initialSort ?? []);
  const [pageIndex, setPageIndex] = useState(0);
  const match = props.globalFilterFn;

  const table = useReactTable({
    data: data ?? [],
    columns,
    getRowId: props.getRowId,
    state: { sorting, globalFilter: props.filter ?? "", pagination: { pageIndex, pageSize } },
    onSortingChange: setSorting,
    onPaginationChange: (u) => setPageIndex((typeof u === "function" ? u({ pageIndex, pageSize }) : u).pageIndex),
    globalFilterFn: (row, _col, value: string) => !match || !value || match(row.original, value.trim().toLowerCase()),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    autoResetPageIndex: true,
  });

  const total = table.getFilteredRowModel().rows.length;
  const pages = Math.max(1, table.getPageCount());
  const colCount = table.getVisibleLeafColumns().length;

  return (
    <div className="rounded-lg border bg-card">
      <Table className="text-[0.8125rem]">
        <TableHeader className="bg-muted/40">
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id} className="hover:bg-transparent">
              {hg.headers.map((h) => {
                const meta = h.column.columnDef.meta as ColumnMeta | undefined;
                const sorted = h.column.getIsSorted();
                const canSort = h.column.getCanSort();
                return (
                  <TableHead
                    key={h.id}
                    className={cn("h-9 whitespace-nowrap px-3", meta?.className)}
                    aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                  >
                    {h.isPlaceholder ? null : canSort ? (
                      <button
                        type="button"
                        className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <TableRow key={`sk-${i}`} className="hover:bg-transparent">
                {Array.from({ length: colCount }).map((__, j) => (
                  <TableCell key={j} className="px-3 py-2.5">
                    <Skeleton className="h-4 w-full max-w-[10rem]" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : error ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={colCount}>
                <ErrorState error={error} onRetry={props.onRetry} />
              </TableCell>
            </TableRow>
          ) : table.getRowModel().rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={colCount}>{props.empty ?? <EmptyState title="Ничего не найдено" />}</TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                className={cn(
                  props.onRowClick && "cursor-pointer focus-visible:bg-muted/60 focus-visible:outline-none",
                  props.rowClassName?.(row.original),
                )}
                tabIndex={props.onRowClick ? 0 : undefined}
                onClick={props.onRowClick ? () => props.onRowClick?.(row.original) : undefined}
                onKeyDown={
                  props.onRowClick
                    ? (e) => {
                        if (e.key === "Enter" && e.target === e.currentTarget) props.onRowClick?.(row.original);
                        if (e.key === "ArrowDown") (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
                        if (e.key === "ArrowUp") (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus();
                      }
                    : undefined
                }
              >
                {row.getVisibleCells().map((cell) => {
                  const meta = cell.column.columnDef.meta as ColumnMeta | undefined;
                  return (
                    <TableCell key={cell.id} className={cn("px-3 py-2", meta?.className)}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {!isLoading && !error && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-sm text-muted-foreground">
          <span>Всего: {total}</span>
          {pages > 1 && (
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="h-8 w-8" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()} aria-label="Назад">
                <ChevronLeft />
              </Button>
              <span className="px-1 tabular-nums">
                {pageIndex + 1} / {pages}
              </span>
              <Button variant="ghost" size="icon" className="h-8 w-8" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()} aria-label="Вперёд">
                <ChevronRight />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Search box with "/" shortcut hint, used in table toolbars. */
export function SearchInput({
  value,
  onChange,
  placeholder = "Поиск",
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const ref = useSlashFocus<HTMLInputElement>();
  return (
    <div className={cn("relative w-full sm:w-64", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={ref}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 pl-8 pr-8"
        aria-label={placeholder}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onChange("");
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border bg-muted px-1.5 text-[10px] text-muted-foreground sm:block">
        /
      </kbd>
    </div>
  );
}
