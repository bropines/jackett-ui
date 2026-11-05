import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Loader2, Plus, Search, SearchX, Timer, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { api, qk } from "@/api";
import { Callout, EmptyState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLocalState, useSlashFocus } from "@/lib/hooks";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { IndexerStrip } from "@/pages/search/IndexerStrip";
import { joinIds, MAIN_CATEGORIES, parseCategories, parseIdList, toggle, toRows, trackersParam } from "@/pages/search/logic";
import { ResultsView } from "@/pages/search/ResultsView";
import { TrackerFilter } from "@/pages/search/TrackerFilter";
import { TIMEOUT_CHOICES, timeoutSeconds } from "@/pages/search/fanout";
import { useFanoutSearch } from "@/pages/search/useFanoutSearch";

export interface SearchPageSearch {
  q?: string;
  t?: string;
  c?: string;
}

const SEARCH_STALE = 5 * 60_000;

/** Seconds since `active` became true (0 while inactive). */
function useElapsedSeconds(active: boolean): number {
  const [start, setStart] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  if (active && start == null) setStart(Date.now());
  if (!active && start != null) setStart(null);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [active]);
  return start == null ? 0 : Math.max(0, Math.floor((now - start) / 1000));
}

export function SearchPage() {
  const search = useSearch({ from: "/" });
  const navigate = useNavigate({ from: "/" });
  const inputRef = useSlashFocus<HTMLInputElement>();

  const q = search.q?.trim() ?? "";
  const trackers = useMemo(() => parseIdList(search.t), [search.t]);
  const categories = useMemo(() => parseCategories(search.c), [search.c]);

  // Input text follows the URL (back/forward, shared links) but is edited locally until submit.
  const [text, setText] = useState(q);
  const [textFor, setTextFor] = useState(q);
  if (textFor !== q) {
    setTextFor(q);
    setText(q);
  }

  const indexersQ = useQuery({ queryKey: qk.indexersConfigured, queryFn: api.configuredIndexers, staleTime: SEARCH_STALE });
  const configured = useMemo(
    () => (indexersQ.data ?? []).filter((i) => i.configured).sort((a, b) => a.name.localeCompare(b.name, "ru")),
    [indexersQ.data],
  );
  const noIndexers = indexersQ.isSuccess && configured.length === 0;

  // One request per tracker. Without the tracker list (it failed to load) fall back to "all".
  const asked = useMemo(() => {
    if (indexersQ.isError) return [{ id: "all", name: "Все трекеры" }];
    if (!indexersQ.isSuccess) return [];
    const names = new Map(configured.map((i) => [i.id, i.name]));
    const ids = trackers.length > 0 ? trackers : configured.map((i) => i.id);
    return ids.map((id) => ({ id, name: names.get(id) ?? id }));
  }, [indexersQ.isError, indexersQ.isSuccess, configured, trackers]);
  const [timeoutRaw, setTimeoutRaw] = useLocalState<number>("jui.search.timeout", 0);
  const timeout = timeoutSeconds(timeoutRaw);
  const res = useFanoutSearch({ query: q, trackers: asked, categories, enabled: q !== "", timeoutMs: timeout * 1000 });
  const fetching = res.fetching;
  const elapsed = useElapsedSeconds(fetching);
  const waitingForList = q !== "" && indexersQ.isPending;
  // Cancelled before any tracker answered.
  const cancelled = q !== "" && !fetching && !res.any && res.cancelledCount > 0;

  const rows = useMemo(() => toRows(res.Results), [res.Results]);
  const statuses = res.Indexers;
  const failedCount = statuses.filter((i) => i.Status === 1).length;

  // "Only this tracker" (client side); ignored once the response no longer has that tracker.
  const [onlyRaw, setOnly] = useState<string | null>(null);
  const only = onlyRaw && statuses.some((s) => s.ID === onlyRaw && s.Status !== 1) ? onlyRaw : null;

  useEffect(() => {
    const prev = document.title;
    document.title = q ? `${q} · Jackett` : "Поиск · Jackett";
    return () => {
      document.title = prev;
    };
  }, [q]);

  const setSearch = (patch: Partial<SearchPageSearch>, replace = false) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const next = text.trim();
    if (next === q && next !== "") {
      void res.refetch();
      return;
    }
    setSearch({ q: next || undefined });
  };


  return (
    <div className="space-y-3">
      <h1 className="sr-only">Поиск</h1>
      <form onSubmit={submit} className="flex gap-2" role="search">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") e.currentTarget.blur();
            }}
            placeholder="Название, год, качество…"
            aria-label="Поисковый запрос"
            autoFocus
            enterKeyHint="search"
            autoComplete="off"
            className="h-10 pl-9 pr-16 text-base md:text-base [&::-webkit-search-cancel-button]:hidden"
          />
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
            {text && (
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setText("");
                  inputRef.current?.focus();
                }}
                aria-label="Очистить"
              >
                <X className="h-4 w-4" />
              </button>
            )}
            <kbd className="pointer-events-none hidden rounded border bg-muted px-1.5 text-[10px] text-muted-foreground sm:block">/</kbd>
          </div>
        </div>
        <Button type="submit" className="h-10 shrink-0 px-3 sm:px-5" disabled={noIndexers}>
          {fetching ? <Loader2 className="animate-spin" /> : <Search className="sm:hidden" />}
          <span className="hidden sm:inline">Найти</span>
          <span className="sr-only sm:hidden">Найти</span>
        </Button>
      </form>

      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 [scrollbar-width:thin]">
        <TrackerFilter
          indexers={configured}
          selected={trackers}
          disabled={!indexersQ.isSuccess || noIndexers}
          onChange={(ids) => setSearch({ t: trackersParam(ids, configured.map((i) => i.id)) }, true)}
        />
        <span className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden />
        <div className="flex gap-1.5" role="group" aria-label="Категории">
          {MAIN_CATEGORIES.map((cat) => {
            const on = categories.includes(cat.id);
            return (
              <button
                key={cat.id}
                type="button"
                aria-pressed={on}
                onClick={() => setSearch({ c: joinIds(toggle(categories, cat.id)) }, true)}
                className={cn(
                  "h-8 shrink-0 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  on ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {cat.name}
              </button>
            );
          })}
          {categories.length > 0 && (
            <button
              type="button"
              className="h-8 shrink-0 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setSearch({ c: undefined }, true)}
            >
              Сбросить
            </button>
          )}
        </div>
        <span className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden />
        <Select value={String(timeout)} onValueChange={(v) => setTimeoutRaw(Number(v))}>
          <SelectTrigger
            className="h-8 w-auto shrink-0 gap-1.5 rounded-full px-3 text-xs"
            aria-label="Сколько ждать каждый трекер"
            title="Сколько ждать каждый трекер. Кто не успел, покажется с ошибкой, остальные результаты останутся."
          >
            <Timer className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIMEOUT_CHOICES.map((sec) => (
              <SelectItem key={sec} value={String(sec)}>
                Ждать {sec} с
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {indexersQ.isError && <Callout variant="error">Не удалось загрузить список трекеров: фильтр по трекерам недоступен.</Callout>}

      {noIndexers ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            title="Нет настроенных трекеров"
            description="Добавьте хотя бы один трекер, чтобы искать."
            action={
              <Button asChild size="sm">
                <Link to="/indexers" search={{ add: "1" }}>
                  <Plus />
                  Добавить трекер
                </Link>
              </Button>
            }
          />
        </div>
      ) : q === "" ? (
        <div className="rounded-lg border bg-card px-4 py-10 text-center">
          <p className="font-medium">Что ищем?</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Введите запрос и нажмите Enter. <kbd className="rounded border bg-muted px-1 text-xs">/</kbd> — перейти к поиску.
          </p>
          {configured.length > 0 && (
            <div className="mx-auto mt-4 max-w-2xl">
              <p className="mb-2 text-xs text-muted-foreground">
                {configured.length} {plural(configured.length, ["трекер", "трекера", "трекеров"])}:
              </p>
              <div className="flex flex-wrap justify-center gap-1.5">
                {configured.map((i) => (
                  <span key={i.id} className="inline-flex items-center gap-1 rounded border bg-muted/40 px-1.5 text-xs leading-5 text-muted-foreground">
                    {i.last_error && <span className="h-1.5 w-1.5 rounded-full bg-destructive" title="Последний запрос с ошибкой" />}
                    {i.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          {fetching && (
            <div className="space-y-1" role="status" aria-live="polite">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                <span>
                  Ищу… ответили <span className="tabular-nums">{res.answered}</span> из{" "}
                  <span className="tabular-nums">{res.total}</span> {plural(res.total, ["трекера", "трекеров", "трекеров"])} ·{" "}
                  <span className="tabular-nums">{elapsed} с</span>
                </span>
                <Button variant="ghost" size="sm" className="ml-auto h-7" onClick={res.cancel}>
                  Отменить
                </Button>
              </div>
              <div className="h-0.5 overflow-hidden rounded bg-muted">
                <div className="h-full w-1/3 animate-[search-progress_1.2s_ease-in-out_infinite] rounded bg-primary" />
              </div>
              <style>{`@keyframes search-progress{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}`}</style>
            </div>
          )}

          {cancelled ? (
            <div className="rounded-lg border bg-card">
              <EmptyState
                icon={SearchX}
                title="Поиск отменён"
                action={
                  <Button variant="outline" size="sm" onClick={() => void res.refetch()}>
                    Искать снова
                  </Button>
                }
              />
            </div>
          ) : res.any ? (
            <>
              <IndexerStrip indexers={statuses} pending={res.pending} only={only} onOnly={setOnly} />
              {rows.length === 0 && fetching ? null : rows.length === 0 ? (
                <div className="rounded-lg border bg-card">
                  <EmptyState
                    icon={SearchX}
                    title="Ничего не найдено"
                    description={
                      failedCount > 0
                        ? `${failedCount} ${plural(failedCount, ["трекер ответил", "трекера ответили", "трекеров ответили"])} ошибкой. Попробуйте другой запрос или проверьте трекеры.`
                        : "Попробуйте изменить запрос или снять фильтры."
                    }
                  />
                </div>
              ) : (
                <ResultsView rows={rows} only={only} onOnly={setOnly} />
              )}
            </>
          ) : fetching || waitingForList ? (
            <div className="space-y-2" aria-hidden>
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
