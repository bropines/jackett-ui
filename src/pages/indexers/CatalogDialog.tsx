import { useVirtualizer } from "@tanstack/react-virtual";
import { ExternalLink, Plus, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { IndexerSummary, IndexerType } from "@/api";
import { EmptyState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDebounced } from "@/lib/hooks";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { LangBadge, TypeBadge } from "@/pages/indexers/badges";
import {
  CATEGORIES,
  EMPTY_FILTER,
  filterCatalog,
  hostOf,
  isFilterActive,
  languageOptions,
  TYPE_LABELS,
  type CatalogFilter,
  type CategoryKey,
} from "@/pages/indexers/logic";
import { pickSelected, toggleId } from "@/pages/indexers/selection";

export function CatalogDialog({
  open,
  onOpenChange,
  indexers,
  onPick,
  onAddMany,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Unconfigured indexers. */
  indexers: IndexerSummary[];
  onPick: (ix: IndexerSummary) => void;
  /** Adds several ticked trackers at once. */
  onAddMany?: (list: IndexerSummary[]) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex h-[100dvh] max-h-[100dvh] w-full max-w-none flex-col gap-3 rounded-none p-0",
          "sm:h-[85vh] sm:w-[calc(100%-2rem)] sm:max-w-4xl sm:rounded-lg",
        )}
        // Keep focus in the search box instead of the first button.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>("input[type=search]")?.focus();
        }}
      >
        {open && <CatalogBody indexers={indexers} onPick={onPick} onAddMany={onAddMany} />}
      </DialogContent>
    </Dialog>
  );
}

function CatalogBody({
  indexers,
  onPick,
  onAddMany,
}: {
  indexers: IndexerSummary[];
  onPick: (ix: IndexerSummary) => void;
  onAddMany?: (list: IndexerSummary[]) => void;
}) {
  const [filter, setFilter] = useState<CatalogFilter>(EMPTY_FILTER);
  const [picked, setPicked] = useState<string[]>([]);
  const togglePick = (id: string) => setPicked((p) => toggleId(p, id));
  const query = useDebounced(filter.query, 150);
  const effective = useMemo(() => ({ ...filter, query }), [filter, query]);
  const results = useMemo(() => filterCatalog(indexers, effective), [indexers, effective]);
  const languages = useMemo(() => languageOptions(indexers), [indexers]);
  const set = (patch: Partial<CatalogFilter>) => setFilter((f) => ({ ...f, ...patch }));

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 76,
    overscan: 8,
    getItemKey: (i) => results[i]?.id ?? i,
  });

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [effective]);

  return (
    <>
      <DialogHeader className="space-y-1 px-4 pt-4 text-left sm:px-6 sm:pt-6">
        <DialogTitle>Добавить трекер</DialogTitle>
        <DialogDescription>
          {formatNumber(indexers.length)} трекеров в Jackett. Нажмите на трекер, чтобы настроить его, или отметьте
          несколько и добавьте разом.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2 px-4 sm:px-6">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={filter.query}
            onChange={(e) => set({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && results[0]) {
                e.preventDefault();
                onPick(results[0]);
              }
            }}
            placeholder="Название, адрес или описание"
            aria-label="Поиск трекера"
            className="pl-8"
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <Select value={filter.type} onValueChange={(v) => set({ type: v as IndexerType | "all" })}>
            <SelectTrigger className="sm:w-44" aria-label="Тип трекера">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Любой тип</SelectItem>
              {(Object.keys(TYPE_LABELS) as IndexerType[]).map((t) => (
                <SelectItem key={t} value={t}>
                  {TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filter.language} onValueChange={(v) => set({ language: v })}>
            <SelectTrigger className="sm:w-56" aria-label="Язык">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              <SelectItem value="all">Любой язык</SelectItem>
              {languages.map((l) => (
                <SelectItem key={l.code} value={l.code}>
                  {l.label} <span className="text-muted-foreground">· {l.count}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Категория">
          <CategoryChip active={filter.category === "all"} onClick={() => set({ category: "all" })}>
            Все
          </CategoryChip>
          {CATEGORIES.map((c) => (
            <CategoryChip
              key={c.key}
              active={filter.category === c.key}
              onClick={() => set({ category: filter.category === c.key ? "all" : (c.key as CategoryKey) })}
            >
              {c.label}
            </CategoryChip>
          ))}
        </div>
        <div className="flex h-6 items-center justify-between text-xs text-muted-foreground">
          <span aria-live="polite">Найдено: {formatNumber(results.length)}</span>
          {isFilterActive(filter) && (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setFilter(EMPTY_FILTER)}>
              <X />
              Сбросить
            </Button>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t">
        {results.length === 0 ? (
          <EmptyState
            icon={Search}
            title="Ничего не найдено"
            description="Попробуйте другое название или сбросьте фильтры."
          />
        ) : (
          <ul className="relative w-full" style={{ height: virtualizer.getTotalSize() }} aria-label="Трекеры">
            {virtualizer.getVirtualItems().map((row) => {
              const ix = results[row.index];
              if (!ix) return null;
              return (
                <li
                  key={row.key}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  <CatalogRow
                    ix={ix}
                    onPick={onPick}
                    checked={picked.includes(ix.id)}
                    onCheck={onAddMany ? () => togglePick(ix.id) : undefined}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {onAddMany && picked.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t bg-background px-4 py-3 sm:px-6">
          <span className="mr-auto text-sm" aria-live="polite">
            Выбрано: {picked.length}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setPicked([])}>
            Снять выделение
          </Button>
          <Button size="sm" onClick={() => onAddMany(pickSelected(indexers, picked))}>
            <Plus />
            Добавить выбранные ({picked.length})
          </Button>
        </div>
      )}
    </>
  );
}

function CategoryChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        active ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {children}
    </button>
  );
}

function CatalogRow({
  ix,
  onPick,
  checked,
  onCheck,
}: {
  ix: IndexerSummary;
  onPick: (ix: IndexerSummary) => void;
  checked: boolean;
  onCheck?: () => void;
}) {
  return (
    <div className={cn("flex items-start gap-3 border-b px-4 py-2.5 hover:bg-accent/50 sm:px-6", checked && "bg-primary/5")}>
      {onCheck && (
        <Checkbox
          className="mt-0.5 h-5 w-5 sm:mt-1 sm:h-4 sm:w-4"
          checked={checked}
          onCheckedChange={onCheck}
          aria-label={`Отметить ${ix.name}`}
        />
      )}
      <button
        type="button"
        className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => onPick(ix)}
      >
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{ix.name}</span>
          <LangBadge code={ix.language} />
          <TypeBadge type={ix.type} />
        </span>
        {ix.description && (
          <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground" title={ix.description}>
            {ix.description}
          </span>
        )}
      </button>
      {ix.site_link && (
        <a
          href={ix.site_link}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-0.5 inline-flex max-w-[40%] shrink-0 items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
          title={ix.site_link}
          aria-label={`Сайт ${ix.name}`}
        >
          <span className="hidden truncate sm:inline">{hostOf(ix.site_link)}</span>
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
        </a>
      )}
    </div>
  );
}
