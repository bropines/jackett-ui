import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeft, ExternalLink, MousePointerClick, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { IndexerSummary, IndexerType } from "@/api";
import { ConfirmDialog, EmptyState } from "@/components/common";
import { IndexerConfigPanel } from "@/components/indexer-config/IndexerConfigPanel";
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

type PaneState = { dirty: boolean; busy: boolean };
const IDLE: PaneState = { dirty: false, busy: false };

/**
 * "Добавить трекер": the catalog on the left, the picked tracker's description and
 * settings on the right (on phones the two take turns). Saving there adds the tracker.
 */
export function CatalogDialog({
  open,
  onOpenChange,
  indexers,
  onAdded,
  onAddMany,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Unconfigured indexers. */
  indexers: IndexerSummary[];
  /** A tracker was set up and saved in the right-hand pane. */
  onAdded?: (id: string) => void;
  /** Adds several ticked trackers at once. */
  onAddMany?: (list: IndexerSummary[]) => void;
}) {
  const pane = useRef<PaneState>(IDLE);
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = () => {
    if (pane.current.busy) return;
    if (pane.current.dirty) setConfirmClose(true);
    else onOpenChange(false);
  };
  return (
    <>
      <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : requestClose())}>
        <DialogContent
          className={cn(
            "flex h-[100dvh] max-h-[100dvh] w-full max-w-none flex-col gap-0 rounded-none p-0",
            "sm:h-[88vh] sm:w-[calc(100%-2rem)] sm:max-w-6xl sm:rounded-lg",
          )}
          onInteractOutside={(e) => {
            if (pane.current.busy) e.preventDefault();
          }}
          // Keep focus in the search box instead of the first button.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>("input[type=search]")?.focus();
          }}
        >
          {open && <CatalogBody indexers={indexers} onAdded={onAdded} onAddMany={onAddMany} paneState={pane} />}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title="Закрыть без сохранения?"
        description="Введённые настройки трекера пропадут."
        confirmLabel="Закрыть"
        destructive
        onConfirm={() => {
          setConfirmClose(false);
          pane.current = IDLE;
          onOpenChange(false);
        }}
      />
    </>
  );
}

/** Marker for "back to the list" in the leave confirmation. */
const BACK = { id: "__back__" } as IndexerSummary;

function CatalogBody({
  indexers,
  onAdded,
  onAddMany,
  paneState,
}: {
  indexers: IndexerSummary[];
  onAdded?: (id: string) => void;
  onAddMany?: (list: IndexerSummary[]) => void;
  paneState: React.MutableRefObject<PaneState>;
}) {
  const [filter, setFilter] = useState<CatalogFilter>(EMPTY_FILTER);
  const [picked, setPicked] = useState<string[]>([]);
  const togglePick = (id: string) => setPicked((p) => toggleId(p, id));
  const query = useDebounced(filter.query, 150);
  const effective = useMemo(() => ({ ...filter, query }), [filter, query]);
  const results = useMemo(() => filterCatalog(indexers, effective), [indexers, effective]);
  const languages = useMemo(() => languageOptions(indexers), [indexers]);
  const set = (patch: Partial<CatalogFilter>) => setFilter((f) => ({ ...f, ...patch }));

  /** The tracker shown in the right-hand pane. */
  const [current, setCurrent] = useState<IndexerSummary | null>(null);
  /** Waiting for "leave without saving?" (BACK = back to the list). */
  const [pending, setPending] = useState<IndexerSummary | null>(null);
  const onPaneState = useCallback(
    (st: PaneState) => {
      paneState.current = st;
    },
    [paneState],
  );
  const show = (ix: IndexerSummary | null) => {
    paneState.current = IDLE;
    setCurrent(ix);
  };
  const leaveTo = (ix: IndexerSummary) => {
    if (paneState.current.busy) return;
    if (paneState.current.dirty) setPending(ix);
    else show(ix === BACK ? null : ix);
  };
  const onPick = (ix: IndexerSummary) => {
    if (ix.id !== current?.id) leaveTo(ix);
  };

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
      <DialogHeader className={cn("space-y-1 border-b px-4 py-4 pr-12 text-left sm:px-6", current && "hidden md:block")}>
        <DialogTitle>Добавить трекер</DialogTitle>
        <DialogDescription>
          {formatNumber(indexers.length)} трекеров в Jackett. Выберите трекер слева, чтобы настроить его справа, или
          отметьте несколько и добавьте разом.
        </DialogDescription>
      </DialogHeader>

      <div className="flex min-h-0 flex-1">
        <div className={cn("flex min-h-0 w-full flex-col md:w-[44%] md:shrink-0 md:border-r", current && "hidden md:flex")}>
          <div className="space-y-2 px-4 pt-3">
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
            <div className="grid grid-cols-2 gap-2">
              <Select value={filter.type} onValueChange={(v) => set({ type: v as IndexerType | "all" })}>
                <SelectTrigger aria-label="Тип трекера">
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
                <SelectTrigger aria-label="Язык">
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
              <EmptyState icon={Search} title="Ничего не найдено" description="Попробуйте другое название или сбросьте фильтры." />
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
                        active={current?.id === ix.id}
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
            <div className="flex flex-wrap items-center gap-2 border-t bg-background px-4 py-3">
              <span className="mr-auto text-sm" aria-live="polite">
                Выбрано: {picked.length}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setPicked([])}>
                Снять
              </Button>
              <Button size="sm" onClick={() => onAddMany(pickSelected(indexers, picked))}>
                <Plus />
                Добавить выбранные ({picked.length})
              </Button>
            </div>
          )}
        </div>

        <section
          className={cn("min-h-0 min-w-0 flex-1 flex-col", current ? "flex" : "hidden md:flex")}
          aria-label={current ? `Настройка: ${current.name}` : "Настройка трекера"}
        >
          {current ? (
            <IndexerConfigPanel
              key={current.id}
              id={current.id}
              title={current.name}
              isNew
              className="flex-1"
              header={<TrackerInfo ix={current} onBack={() => leaveTo(BACK)} />}
              onStateChange={onPaneState}
              onCancel={() => leaveTo(BACK)}
              onSaved={(id) => {
                show(null);
                setPicked((p) => p.filter((x) => x !== id));
                onAdded?.(id);
              }}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState
                icon={MousePointerClick}
                title="Выберите трекер"
                description="Здесь появятся его описание и настройки. Публичным трекерам обычно нечего заполнять: достаточно нажать «Добавить»."
              />
            </div>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title="Уйти без сохранения?"
        description={`Введённые настройки ${current?.name ?? "трекера"} пропадут.`}
        confirmLabel="Уйти"
        destructive
        onConfirm={() => {
          const next = pending;
          setPending(null);
          show(next === BACK ? null : next);
        }}
      />
    </>
  );
}

function TrackerInfo({ ix, onBack }: { ix: IndexerSummary; onBack: () => void }) {
  return (
    <div className="mb-4 space-y-2 border-b pb-4">
      <Button variant="ghost" size="sm" className="-ml-2 h-8 md:hidden" onClick={onBack}>
        <ArrowLeft /> К списку
      </Button>
      <div className="flex flex-wrap items-center gap-1.5">
        <h3 className="text-lg font-semibold leading-tight">{ix.name}</h3>
        <LangBadge code={ix.language} />
        <TypeBadge type={ix.type} />
      </div>
      {ix.description && <p className="text-sm text-muted-foreground">{ix.description}</p>}
      {ix.site_link && (
        <a
          href={ix.site_link}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline"
        >
          <span className="truncate">{hostOf(ix.site_link)}</span>
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
        </a>
      )}
    </div>
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
  active,
  checked,
  onCheck,
}: {
  ix: IndexerSummary;
  onPick: (ix: IndexerSummary) => void;
  active: boolean;
  checked: boolean;
  onCheck?: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 border-b border-l-2 border-l-transparent px-4 py-2.5 hover:bg-accent/50",
        checked && "bg-primary/5",
        active && "border-l-primary bg-accent",
      )}
    >
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
        aria-current={active ? "true" : undefined}
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
          <span className="hidden truncate lg:inline">{hostOf(ix.site_link)}</span>
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
        </a>
      )}
    </div>
  );
}
