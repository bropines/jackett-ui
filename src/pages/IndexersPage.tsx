import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ListChecks, Loader2, Plus, Radar, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { api, errText, qk, torznabUrl, type IndexerSummary } from "@/api";
import { ConfirmDialog, copyText, EmptyState, ErrorState, PageHeader, toastError } from "@/components/common";
import { SearchInput } from "@/components/data-table";
import { IndexerConfigDialog } from "@/components/indexer-config/IndexerConfigDialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox, Skeleton } from "@/components/ui/misc";
import { useCan } from "@/lib/auth-hooks";
import { plural } from "@/lib/format";
import { BulkAddDialog } from "@/pages/indexers/BulkAddDialog";
import { BulkBar } from "@/pages/indexers/BulkBar";
import { CatalogDialog } from "@/pages/indexers/CatalogDialog";
import { IndexerRow } from "@/pages/indexers/IndexerRow";
import { effectiveStatus, filterConfigured, firstLine, runQueue, type TestState } from "@/pages/indexers/logic";
import { QbitHelp } from "@/pages/indexers/QbitHelp";
import { namesPreview, pickSelected, pruneSelection, toggleId, toggleVisible, visibleCheckState } from "@/pages/indexers/selection";
import { useBulkAdd } from "@/pages/indexers/useBulkAdd";

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
  // Viewers see the configured list read-only; the server answers 403 to the rest anyway.
  const canManage = useCan("editor");
  const addOpen = canManage && search.add !== undefined;
  const editId = canManage ? (search.edit ?? null) : null;

  // Configured list is tiny; the full catalog (~400 KB gzipped) loads only when it is needed:
  // catalog open, the empty-state quick picks, or editing an indexer that is not configured yet.
  const indexersQ = useQuery({ queryKey: qk.indexersConfigured, queryFn: api.configuredIndexers, staleTime: INDEXERS_STALE_MS });
  const configured = useMemo(() => indexersQ.data ?? [], [indexersQ.data]);
  const needCatalog =
    canManage &&
    (addOpen ||
      (indexersQ.isSuccess && configured.length === 0) ||
      (editId !== null && indexersQ.isSuccess && !configured.some((x) => x.id === editId)));
  const catalogQ = useQuery({ queryKey: qk.indexersAll, queryFn: api.indexers, staleTime: INDEXERS_STALE_MS, enabled: needCatalog });

  const all = useMemo(() => catalogQ.data ?? configured, [catalogQ.data, configured]);
  const unconfigured = useMemo(() => (catalogQ.data ?? []).filter((x) => !x.configured), [catalogQ.data]);

  const [filter, setFilter] = useState("");
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const stopBulk = useRef(false);
  const [toDelete, setToDelete] = useState<IndexerSummary | null>(null);

  /* Multi-select: ids of configured trackers; ones that disappear (deleted) drop out. */
  const [selectedRaw, setSelected] = useState<string[]>([]);
  const selected = useMemo(() => pruneSelection(selectedRaw, configured), [selectedRaw, configured]);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [deleting, setDeleting] = useState<{ done: number; total: number } | null>(null);

  /* Adding several trackers from the catalog; those that need input are configured one by one. */
  const bulkAdd = useBulkAdd();
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [setupMode, setSetupMode] = useState(false);
  /** The config dialog calls onSaved and then closes itself: skip that close while moving to the next tracker. */
  const skipClose = useRef(false);
  const setupLeft = bulkAdd.items?.filter((it) => it.status === "setup").length ?? 0;
  useEffect(() => {
    if (setupMode && setupLeft > 0) toast.message(`Осталось настроить: ${setupLeft}`, { id: "setup-queue", duration: Infinity });
    else toast.dismiss("setup-queue");
  }, [setupMode, setupLeft]);
  useEffect(() => () => void toast.dismiss("setup-queue"), []);

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
  const selectedItems = useMemo(() => pickSelected(filterConfigured(configured, ""), selected), [configured, selected]);

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

  const testMany = async (items: IndexerSummary[]) => {
    const list = [...items];
    if (list.length === 0 || bulk) return;
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

  /* ── Bulk actions on the selection ── */

  const deleteSelected = async () => {
    const list = selectedItems;
    if (list.length === 0) return;
    setDeleting({ done: 0, total: list.length });
    const results = await runQueue(list, (ix) => api.deleteIndexer(ix.id), {
      concurrency: 1,
      onProgress: (done, total) => setDeleting({ done, total }),
    });
    setDeleting(null);
    setConfirmBulkDelete(false);
    const gone = new Set(results.filter((r) => r.ok).map((r) => r.item.id));
    setTests((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !gone.has(id))));
    setSelected((prev) => prev.filter((id) => !gone.has(id)));
    void qc.invalidateQueries({ queryKey: qk.indexers });
    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) toast.success(`Удалено: ${trackers(gone.size)}`);
    else
      toast.error(`Удалено ${gone.size} из ${list.length}`, {
        description: failed.map((r) => (r.ok ? "" : `${r.item.name}: ${firstLine(errText(r.error), 120)}`)).join("\n"),
      });
  };

  const copySelectedTorznab = async () => {
    const urls = selectedItems.map((ix) => torznabUrl(ix.id)).filter(Boolean);
    if (urls.length === 0) {
      toast.error("Torznab-адреса: пока нет данных");
      return;
    }
    if (await copyText(urls.join("\n"))) toast.success(`Скопировано адресов: ${urls.length}`);
    else toast.error("Не удалось скопировать");
  };

  /* ── Bulk add from the catalog ── */

  const addMany = (list: IndexerSummary[]) => {
    setSearch({ add: undefined }, true);
    setSummaryOpen(true);
    void bulkAdd.start(list);
  };
  const nextSetup = (after?: string) => bulkAdd.items?.find((it) => it.status === "setup" && it.id !== after);
  const startSetup = () => {
    const first = nextSetup();
    if (!first) return;
    setSummaryOpen(false);
    setSetupMode(true);
    setSearch({ edit: first.id });
  };
  const closeSummary = () => {
    setSummaryOpen(false);
    bulkAdd.reset();
  };

  /* ── Dialogs ── */

  const editing = editId ? all.find((x) => x.id === editId) : undefined;

  const openCatalog = () => setSearch({ add: "1", edit: undefined });
  // Added in the catalog's right-hand pane: the catalog stays open for the next one.
  const onCatalogAdded = (id: string) => {
    setTests(({ [id]: _old, ...rest }) => rest);
    void qc.invalidateQueries({ queryKey: qk.indexers });
  };
  const quickPick = (ix: IndexerSummary) => {
    setSearch({ add: undefined, edit: ix.id });
  };
  const closeEdit = () => {
    if (skipClose.current) {
      skipClose.current = false;
      return;
    }
    if (setupMode) {
      // Cancelled one of the queue: back to the summary, where the rest can be configured later.
      setSetupMode(false);
      setSummaryOpen(true);
      setSearch({ edit: undefined }, true);
      return;
    }
    setSearch({ edit: undefined }, true);
  };
  // The dialog itself toasts the save and starts a background test.
  const onSaved = (id: string) => {
    setTests(({ [id]: _old, ...rest }) => rest);
    void qc.invalidateQueries({ queryKey: qk.indexers });
    if (setupMode) {
      bulkAdd.setStatus(id, "added");
      const next = nextSetup(id);
      skipClose.current = true;
      if (next) setSearch({ edit: next.id }, true);
      else {
        setSetupMode(false);
        setSummaryOpen(true);
        setSearch({ edit: undefined, add: undefined }, true);
      }
      return;
    }
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
        canManage && (
        <>
          {configured.length > 0 &&
            (testing ? (
              <Button variant="outline" onClick={() => (stopBulk.current = true)} title="Остановить проверку">
                <Loader2 className="animate-spin" />
                {bulk.done} / {bulk.total}
                <Square className="ml-1 fill-current" aria-label="Остановить" />
              </Button>
            ) : (
              <Button variant="outline" onClick={() => void testMany(configured)}>
                <ListChecks />
                Проверить все
              </Button>
            ))}
          <Button onClick={openCatalog} disabled={addOpen && catalogQ.isFetching}>
            {addOpen && catalogQ.isFetching ? <Loader2 className="animate-spin" /> : <Plus />}
            Добавить трекер
          </Button>
        </>
        )
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
  } else if (configured.length === 0 && !canManage) {
    body = (
      <Card className="shadow-none">
        <EmptyState icon={Radar} title="Пока ни одного трекера" description="Трекеры добавляет администратор или редактор. Попросите их подключить нужные." />
      </Card>
    );
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
            <>
              <div className="flex items-center gap-3 border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
                <Checkbox
                  id="indexers-select-visible"
                  className="h-5 w-5 sm:h-4 sm:w-4"
                  checked={visibleCheckState(selected, visible)}
                  onCheckedChange={() => setSelected(toggleVisible(selected, visible))}
                />
                <label htmlFor="indexers-select-visible" className="cursor-pointer select-none">
                  {filter || onlyErrors ? `Выбрать найденные (${visible.length})` : `Выбрать все (${visible.length})`}
                </label>
                {selected.length > 0 && <span className="ml-auto">Выбрано: {selected.length}</span>}
              </div>
              <ul className="divide-y" aria-label="Подключённые трекеры">
                {visible.map((ix) => (
                  <IndexerRow
                    key={ix.id}
                    ix={ix}
                    test={tests[ix.id]}
                    canManage={canManage}
                    onTest={() => testOne(ix)}
                    onEdit={() => setSearch({ edit: ix.id })}
                    onDelete={() => setToDelete(ix)}
                    selected={selected.includes(ix.id)}
                    onSelect={() => setSelected((prev) => toggleId(prev, ix.id))}
                  />
                ))}
              </ul>
            </>
          )}
        </Card>
        {selected.length > 0 && (
          <BulkBar
            count={selected.length}
            canManage={canManage}
            testing={bulk}
            onTest={() => void testMany(selectedItems)}
            onStopTest={() => (stopBulk.current = true)}
            onDelete={() => setConfirmBulkDelete(true)}
            onCopy={() => void copySelectedTorznab()}
            onClear={() => setSelected([])}
          />
        )}
      </>
    );
  }

  return (
    <div className="min-w-0">
      {header}
      <QbitHelp />
      {body}

      <CatalogDialog
        open={addOpen && !!catalogQ.data}
        onOpenChange={(open) => (open ? openCatalog() : setSearch({ add: undefined }, true))}
        indexers={unconfigured}
        onAdded={onCatalogAdded}
        onAddMany={addMany}
      />

      {bulkAdd.items && (
        <BulkAddDialog
          open={summaryOpen}
          items={bulkAdd.items}
          running={bulkAdd.running}
          onStop={bulkAdd.stop}
          onClose={closeSummary}
          onSetup={startSetup}
        />
      )}

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

      <ConfirmDialog
        open={confirmBulkDelete}
        onOpenChange={(open) => !open && !deleting && setConfirmBulkDelete(false)}
        title={`Удалить ${trackers(selectedItems.length)}?`}
        description={
          <>
            <span className="block break-words font-medium text-foreground">{namesPreview(selectedItems.map((ix) => ix.name))}</span>
            <span className="mt-2 block">Настройки и данные для входа будут удалены из Jackett. Трекеры можно добавить снова из каталога.</span>
          </>
        }
        confirmLabel={deleting ? `Удаляю ${deleting.done} / ${deleting.total}…` : "Удалить"}
        destructive
        pending={deleting !== null}
        onConfirm={() => void deleteSelected()}
      />
    </div>
  );
}
