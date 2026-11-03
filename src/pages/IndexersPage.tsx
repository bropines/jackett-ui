import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ListChecks, Loader2, Plus, Radar, Square } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { api, errText, getApiKey, qk, type IndexerSummary } from "@/api";
import { ConfirmDialog, EmptyState, ErrorState, PageHeader, toastError } from "@/components/common";
import { SearchInput } from "@/components/data-table";
import { IndexerConfigDialog } from "@/components/indexer-config/IndexerConfigDialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { plural } from "@/lib/format";
import { CatalogDialog } from "@/pages/indexers/CatalogDialog";
import { IndexerRow } from "@/pages/indexers/IndexerRow";
import { effectiveStatus, filterConfigured, firstLine, runQueue, type TestState } from "@/pages/indexers/logic";
import { QbitHelp } from "@/pages/indexers/QbitHelp";

export interface IndexersPageSearch {
  add?: string;
  edit?: string;
}

/** The indexer list is ~1.5 MB: keep it fresh for a few minutes. */
const INDEXERS_STALE_MS = 5 * 60_000;
const TEST_CONCURRENCY = 3;

/** Popular trackers offered on the empty state (ids from Jackett's catalog). */
const QUICK_PICKS = ["rutracker", "kinozal", "rutor", "noname-club", "1337x", "thepiratebay"];

const trackers = (n: number) => `${n} ${plural(n, ["трекер", "трекера", "трекеров"])}`;

export function IndexersPage() {
  const search = useSearch({ from: "/indexers" });
  const navigate = useNavigate({ from: "/indexers" });
  const qc = useQueryClient();

  // Configured list is tiny; the full catalog (~400 KB gzipped) loads only when it is needed:
  // catalog open, the empty-state quick picks, or editing an indexer that is not configured yet.
  const indexersQ = useQuery({ queryKey: qk.indexersConfigured, queryFn: api.configuredIndexers, staleTime: INDEXERS_STALE_MS });
  const configured = useMemo(() => indexersQ.data ?? [], [indexersQ.data]);
  const needCatalog =
    search.add !== undefined ||
    (indexersQ.isSuccess && configured.length === 0) ||
    (search.edit !== undefined && indexersQ.isSuccess && !configured.some((x) => x.id === search.edit));
  const catalogQ = useQuery({ queryKey: qk.indexersAll, queryFn: api.indexers, staleTime: INDEXERS_STALE_MS, enabled: needCatalog });
  const configQ = useQuery({ queryKey: qk.serverConfig, queryFn: api.serverConfig, staleTime: INDEXERS_STALE_MS });
  const apiKey = configQ.data?.api_key || getApiKey();

  const all = useMemo(() => catalogQ.data ?? configured, [catalogQ.data, configured]);
  const unconfigured = useMemo(() => (catalogQ.data ?? []).filter((x) => !x.configured), [catalogQ.data]);

  const [filter, setFilter] = useState("");
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const stopBulk = useRef(false);
  const [toDelete, setToDelete] = useState<IndexerSummary | null>(null);
  /** Set when the config dialog was opened from the catalog: closing it without saving goes back there. */
  const backToCatalog = useRef(false);

  const setSearch = useCallback(
    (patch: Partial<IndexersPageSearch>, replace = false) =>
      void navigate({ search: (prev: IndexersPageSearch) => ({ ...prev, ...patch }), replace }),
    [navigate],
  );

  const errorCount = configured.filter((ix) => effectiveStatus(ix, tests[ix.id]).kind === "error").length;
  const visible = useMemo(() => {
    const list = filterConfigured(configured, filter);
    return onlyErrors ? list.filter((ix) => effectiveStatus(ix, tests[ix.id]).kind === "error") : list;
  }, [configured, filter, onlyErrors, tests]);

  /* ── Tests ── */

  const setTest = (id: string, t: TestState) => setTests((prev) => ({ ...prev, [id]: t }));

  const runTest = async (ix: IndexerSummary): Promise<void> => {
    setTest(ix.id, { status: "running" });
    try {
      await api.testIndexer(ix.id);
      setTest(ix.id, { status: "ok", at: Date.now() });
    } catch (err) {
      setTest(ix.id, { status: "error", error: errText(err), at: Date.now() });
      throw err;
    }
  };

  const testOne = (ix: IndexerSummary) => {
    runTest(ix).then(
      () => toast.success(`${ix.name}: работает`),
      (err) => toast.error(`${ix.name}: ${firstLine(errText(err), 200)}`),
    );
  };

  const testAll = async () => {
    const list = [...configured];
    if (list.length === 0) return;
    stopBulk.current = false;
    setBulk({ done: 0, total: list.length });
    const results = await runQueue(list, runTest, {
      concurrency: TEST_CONCURRENCY,
      onProgress: (done, total) => setBulk({ done, total }),
      shouldStop: () => stopBulk.current,
    });
    setBulk(null);
    const failed = results.filter((r) => !r.ok);
    const stopped = results.length < list.length ? ` (остановлено, проверено ${results.length} из ${list.length})` : "";
    if (failed.length === 0) toast.success(`Все работают: ${trackers(results.length)}${stopped}`);
    else
      toast.error(`С ошибкой ${failed.length} из ${results.length}${stopped}`, {
        description: failed.map((r) => r.item.name).join(", "),
      });
  };

  /* ── Delete ── */

  const del = useMutation({
    mutationFn: (ix: IndexerSummary) => api.deleteIndexer(ix.id),
    onSuccess: (_, ix) => {
      toast.success(`${ix.name} удалён`);
      setToDelete(null);
      setTests(({ [ix.id]: _gone, ...rest }) => rest);
      void qc.invalidateQueries({ queryKey: qk.indexers });
    },
    onError: toastError,
  });

  /* ── Dialogs ── */

  const editId = search.edit ?? null;
  const editing = editId ? all.find((x) => x.id === editId) : undefined;

  const openCatalog = () => setSearch({ add: "1", edit: undefined });
  const pick = (ix: IndexerSummary) => {
    backToCatalog.current = true;
    setSearch({ add: undefined, edit: ix.id }, true);
  };
  const quickPick = (ix: IndexerSummary) => {
    backToCatalog.current = false;
    setSearch({ add: undefined, edit: ix.id });
  };
  const closeEdit = () => {
    const back = backToCatalog.current;
    backToCatalog.current = false;
    setSearch({ edit: undefined, add: back ? "1" : undefined }, true);
  };
  // The dialog itself toasts the save and starts a background test.
  const onSaved = (id: string) => {
    backToCatalog.current = false;
    setTests(({ [id]: _old, ...rest }) => rest);
    void qc.invalidateQueries({ queryKey: qk.indexers });
    setSearch({ edit: undefined, add: undefined }, true);
  };

  /* ── Render ── */

  const testing = bulk !== null;
  const header = (
    <PageHeader
      title="Трекеры"
      description={
        indexersQ.data
          ? `Подключено: ${configured.length}${catalogQ.data ? ` из ${catalogQ.data.length}` : ""}${errorCount ? ` · с ошибкой: ${errorCount}` : ""}`
          : "Трекеры, через которые ищет Jackett"
      }
      actions={
        <>
          {configured.length > 0 &&
            (testing ? (
              <Button variant="outline" onClick={() => (stopBulk.current = true)} title="Остановить проверку">
                <Loader2 className="animate-spin" />
                {bulk.done} / {bulk.total}
                <Square className="ml-1 fill-current" aria-label="Остановить" />
              </Button>
            ) : (
              <Button variant="outline" onClick={() => void testAll()}>
                <ListChecks />
                Проверить все
              </Button>
            ))}
          <Button onClick={openCatalog} disabled={search.add !== undefined && catalogQ.isFetching}>
            {search.add !== undefined && catalogQ.isFetching ? <Loader2 className="animate-spin" /> : <Plus />}
            Добавить трекер
          </Button>
        </>
      }
    />
  );

  let body: React.ReactNode;
  if (indexersQ.isPending) {
    body = (
      <Card className="divide-y">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-2 px-4 py-3">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-72 max-w-full" />
          </div>
        ))}
      </Card>
    );
  } else if (indexersQ.isError) {
    body = <ErrorState error={indexersQ.error} onRetry={() => void indexersQ.refetch()} />;
  } else if (configured.length === 0) {
    const picks = QUICK_PICKS.map((id) => unconfigured.find((x) => x.id === id)).filter((x): x is IndexerSummary => !!x);
    body = (
      <Card className="shadow-none">
        <EmptyState
          icon={Radar}
          title="Пока ни одного трекера"
          description={`В Jackett ${trackers(all.length)}: публичные, полуприватные и приватные. Добавьте нужные, и поиск заработает.`}
          action={
            <div className="flex flex-col items-center gap-4">
              <Button size="lg" onClick={openCatalog}>
                <Plus />
                Выбрать трекер
              </Button>
              {picks.length > 0 && (
                <div className="flex max-w-md flex-wrap justify-center gap-1.5">
                  <span className="w-full text-xs text-muted-foreground">Популярные:</span>
                  {picks.map((ix) => (
                    <Button key={ix.id} variant="outline" size="sm" onClick={() => quickPick(ix)}>
                      {ix.name}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          }
        />
      </Card>
    );
  } else {
    body = (
      <>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <SearchInput value={filter} onChange={setFilter} placeholder="Фильтр трекеров" />
          {errorCount > 0 && (
            <Button
              variant={onlyErrors ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={onlyErrors}
              onClick={() => setOnlyErrors(!onlyErrors)}
            >
              Только с ошибкой ({errorCount})
            </Button>
          )}
        </div>
        <Card className="overflow-hidden shadow-none">
          {visible.length === 0 ? (
            <EmptyState title="Ничего не найдено" description="Измените фильтр." />
          ) : (
            <ul className="divide-y" aria-label="Подключённые трекеры">
              {visible.map((ix) => (
                <IndexerRow
                  key={ix.id}
                  ix={ix}
                  test={tests[ix.id]}
                  apiKey={apiKey}
                  onTest={() => testOne(ix)}
                  onEdit={() => {
                    backToCatalog.current = false;
                    setSearch({ edit: ix.id });
                  }}
                  onDelete={() => setToDelete(ix)}
                />
              ))}
            </ul>
          )}
        </Card>
      </>
    );
  }

  return (
    <div className="min-w-0">
      {header}
      <QbitHelp apiKey={apiKey} />
      {body}

      <CatalogDialog
        open={search.add !== undefined && !!catalogQ.data}
        onOpenChange={(open) => (open ? openCatalog() : setSearch({ add: undefined }, true))}
        indexers={unconfigured}
        onPick={pick}
      />

      <IndexerConfigDialog
        indexerId={editId}
        indexerName={editing?.name}
        isNew={editing ? !editing.configured : undefined}
        onOpenChange={(open) => {
          if (!open) closeEdit();
        }}
        onSaved={onSaved}
      />

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && !del.isPending && setToDelete(null)}
        title={`Удалить ${toDelete?.name ?? "трекер"}?`}
        description="Настройки и данные для входа будут удалены из Jackett. Трекер можно добавить снова из каталога."
        confirmLabel={del.isPending ? "Удаляю…" : "Удалить"}
        destructive
        pending={del.isPending}
        onConfirm={() => toDelete && del.mutate(toDelete)}
      />
    </div>
  );
}
