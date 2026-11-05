import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, ExternalLink, FileCode2, Loader2, Pencil, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { errText, qk } from "@/api";
import { definitionsApi, definitionsKeys, type Definition, type ReloadResult } from "@/api/definitions";
import { Callout, ConfirmDialog, EmptyState, ErrorState, Mono, PageHeader, RelativeTime, toastError } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton, Textarea } from "@/components/ui/misc";

import {
  DEFINITION_DOCS_URL,
  DEFINITION_EXAMPLES_URL,
  definitionProblems,
  definitionTemplate,
  validDefinitionId,
} from "./logic";

export interface DefinitionsPageSearch {
  /** Open the editor for this id. */
  edit?: string;
  /** "1": the editor for a new file (id in `edit`). */
  new?: string;
}

function DocsLinks() {
  return (
    <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
      <a className="inline-flex items-center gap-1 underline underline-offset-2" href={DEFINITION_DOCS_URL} target="_blank" rel="noreferrer">
        Формат файла <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
      <a className="inline-flex items-center gap-1 underline underline-offset-2" href={DEFINITION_EXAMPLES_URL} target="_blank" rel="noreferrer">
        Примеры: встроенные трекеры <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    </span>
  );
}

/** Runs the reload and shows its result. */
function useReload() {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<ReloadResult | null>(null);
  const m = useMutation({
    mutationFn: definitionsApi.reload,
    onSuccess: (r) => {
      setResult(r);
      void queryClient.invalidateQueries({ queryKey: qk.indexers });
      if (r.ok) toast.success("Jackett перечитал трекеры");
      else toast.warning("Jackett перезапускается дольше обычного");
    },
    onError: toastError,
  });
  return { reload: () => m.mutate(), pending: m.isPending, result, clear: () => setResult(null) };
}

function ReloadMessages({ result }: { result: ReloadResult }) {
  if (result.messages.length === 0) {
    return result.ok ? (
      <Callout variant="info" title="Готово">
        Ошибок в журнале Jackett нет. Новый трекер появится в каталоге на странице{" "}
        <Link to="/indexers" search={{ add: "1" }} className="underline underline-offset-2">
          «Трекеры» → «Добавить»
        </Link>
        .
      </Callout>
    ) : null;
  }
  return (
    <Callout variant="warning" title="Сообщения Jackett">
      <ul className="mt-1 max-h-60 space-y-1 overflow-y-auto break-words font-mono text-xs">
        {result.messages.map((m, i) => (
          <li key={i}>{m}</li>
        ))}
      </ul>
    </Callout>
  );
}

function NewDefinitionDialog({ open, onOpenChange, taken }: { open: boolean; onOpenChange: (o: boolean) => void; taken: string[] }) {
  const navigate = useNavigate();
  const [id, setId] = useState("");
  const clean = id.trim().toLowerCase();
  const error = clean === "" ? null : !validDefinitionId(clean) ? "Латиница в нижнем регистре, цифры, точка, _ и -" : taken.includes(clean) ? "Такой файл уже есть" : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setId("");
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!clean || error) return;
            onOpenChange(false);
            void navigate({ to: "/definitions", search: { edit: clean, new: "1" } });
          }}
        >
          <DialogHeader>
            <DialogTitle>Новый трекер</DialogTitle>
            <DialogDescription>
              id станет именем файла. Если он совпадёт с id встроенного трекера, ваш файл заменит встроенный.
            </DialogDescription>
          </DialogHeader>
          <div className="my-4 space-y-1.5">
            <Label htmlFor="def-id">id</Label>
            <Input id="def-id" value={id} onChange={(e) => setId(e.target.value)} placeholder="my-tracker" autoFocus autoComplete="off" spellCheck={false} />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={!clean || !!error}>
              Создать
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Editor({ id, isNew }: { id: string; isNew: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileQ = useQuery({ queryKey: definitionsKeys.file(id), queryFn: () => definitionsApi.get(id), enabled: !isNew, retry: false });
  const [text, setText] = useState<string | null>(isNew ? definitionTemplate(id) : null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { reload, pending: reloading, result } = useReload();

  useEffect(() => {
    if (text === null && fileQ.data) setText(fileQ.data.content);
  }, [fileQ.data, text]);

  const content = text ?? "";
  const dirty = isNew || (fileQ.data !== undefined && content !== fileQ.data.content);
  const problems = definitionProblems(id, content);

  const save = useMutation({
    mutationFn: () => definitionsApi.save(id, content),
    onSuccess: async () => {
      setSaveError(null);
      await queryClient.invalidateQueries({ queryKey: definitionsKeys.list });
      queryClient.setQueryData(definitionsKeys.file(id), (old: unknown) => (old ? { ...(old as object), content } : old));
      if (isNew) void navigate({ to: "/definitions", search: { edit: id }, replace: true });
    },
    onError: (e) => setSaveError(errText(e)),
  });
  const remove = useMutation({
    mutationFn: () => definitionsApi.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: definitionsKeys.list });
      toast.success("Файл удалён. Нажмите «Применить в Jackett», чтобы он пропал из каталога.");
      void navigate({ to: "/definitions", search: {} });
    },
    onError: toastError,
  });

  const busy = save.isPending || reloading;

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        back={
          <Link to="/definitions" search={{}} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Свои трекеры
          </Link>
        }
        title={
          <>
            <FileCode2 className="h-5 w-5" aria-hidden /> <Mono>{id}.yml</Mono>
            {isNew && <Badge variant="secondary">новый</Badge>}
          </>
        }
        description={<DocsLinks />}
        actions={
          <>
            {!isNew && (
              <Button variant="outline" onClick={() => setConfirmDelete(true)} disabled={busy}>
                <Trash2 aria-hidden /> Удалить
              </Button>
            )}
            <Button variant="outline" onClick={() => save.mutate()} disabled={busy || !dirty || problems.length > 0}>
              {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />} Сохранить
            </Button>
            <Button
              onClick={() => {
                if (dirty) save.mutate(undefined, { onSuccess: () => reload() });
                else reload();
              }}
              disabled={busy || problems.length > 0}
            >
              {reloading ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
              {dirty ? "Сохранить и применить" : "Применить в Jackett"}
            </Button>
          </>
        }
      />

      {fileQ.isError && <ErrorState error={fileQ.error} onRetry={() => void fileQ.refetch()} />}
      {saveError && (
        <Callout variant="error" title="Не сохранено">
          {saveError}
        </Callout>
      )}
      {problems.length > 0 && text !== null && (
        <Callout variant="warning" title="Исправьте перед сохранением">
          <ul className="list-disc pl-4">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Callout>
      )}
      {reloading && (
        <Callout variant="info" title="Jackett перезапускается…">
          Обычно это занимает несколько секунд. Поиск в это время не работает.
        </Callout>
      )}
      {result && <ReloadMessages result={result} />}

      {text === null && !fileQ.isError ? (
        <Skeleton className="h-[60vh] w-full" />
      ) : (
        <div>
          <Label htmlFor="def-content" className="sr-only">
            Содержимое {id}.yml
          </Label>
          <Textarea
            id="def-content"
            value={content}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Tab inserts two spaces (YAML indent) instead of leaving the field.
              if (e.key !== "Tab" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
              e.preventDefault();
              const el = e.currentTarget;
              const { selectionStart: a, selectionEnd: b } = el;
              const next = content.slice(0, a) + "  " + content.slice(b);
              setText(next);
              requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="h-[65vh] min-h-[320px] resize-y whitespace-pre font-mono text-xs leading-5 [tab-size:2]"
          />
          <p className="mt-1 text-xs text-muted-foreground">Tab вставляет два пробела. Esc, затем Tab — перейти дальше.</p>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Удалить ${id}.yml?`}
        description="Если трекер уже добавлен в Jackett, после применения он перестанет работать."
        confirmLabel="Удалить"
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

function DefinitionCard({ d }: { d: Definition }) {
  return (
    <li className="flex items-center gap-3 rounded-lg border bg-card p-3">
      <FileCode2 className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{d.name || d.id}</span>
          <Mono className="text-xs text-muted-foreground">{d.file}</Mono>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
          <span>
            изменён <RelativeTime iso={d.modifiedAt} />
          </span>
          <span>{Math.max(1, Math.round(d.size / 1024))} КБ</span>
        </div>
        {d.problem && (
          <p className="mt-1 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden /> {d.problem}
          </p>
        )}
      </div>
      {!d.problem || d.problem.startsWith("id в файле") ? (
        <Button asChild variant="outline" size="sm">
          <Link to="/definitions" search={{ edit: d.id }}>
            <Pencil aria-hidden /> <span className="hidden sm:inline">Изменить</span>
            <span className="sr-only sm:hidden">Изменить {d.id}</span>
          </Link>
        </Button>
      ) : null}
    </li>
  );
}

function List() {
  const q = useQuery({ queryKey: definitionsKeys.list, queryFn: definitionsApi.list });
  const [creating, setCreating] = useState(false);
  const { reload, pending: reloading, result } = useReload();
  const items = q.data?.items ?? [];
  const available = q.data?.available ?? false;

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="Свои трекеры"
        description={
          <>
            Трекеры, которых нет в Jackett, описываются YAML-файлом (формат Cardigann). Компилировать ничего не нужно. <DocsLinks />
          </>
        }
        actions={
          available && (
            <>
              <Button variant="outline" onClick={reload} disabled={reloading}>
                {reloading ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />} Применить в Jackett
              </Button>
              <Button onClick={() => setCreating(true)}>
                <Plus aria-hidden /> Новый трекер
              </Button>
            </>
          )
        }
      />

      {q.isPending && <Skeleton className="h-32 w-full" />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && !available && (
        <Callout variant="warning" title="Папка не подключена">
          <p>{q.data.reason}</p>
          <p className="mt-2">
            Панель должна видеть папку <Mono>cardigann/definitions</Mono> из конфига Jackett. В образе aio и в Helm-чарте это настроено. Для
            отдельного контейнера смонтируйте её в контейнер панели и задайте <Mono>CARDIGANN_DIR</Mono>.
          </p>
        </Callout>
      )}
      {reloading && (
        <Callout variant="info" title="Jackett перезапускается…">
          Обычно это занимает несколько секунд.
        </Callout>
      )}
      {result && <ReloadMessages result={result} />}

      {q.data && available && (
        <>
          <p className="text-xs text-muted-foreground">
            Папка: <Mono>{q.data.dir}</Mono>. После изменений нажмите «Применить в Jackett»: он перечитает файлы за несколько секунд.
          </p>
          {items.length === 0 ? (
            <div className="rounded-lg border bg-card">
              <EmptyState
                icon={FileCode2}
                title="Своих трекеров пока нет"
                description="Создайте файл из шаблона или скопируйте встроенный трекер и поправьте под свой сайт."
                action={
                  <Button onClick={() => setCreating(true)}>
                    <Plus aria-hidden /> Новый трекер
                  </Button>
                }
              />
            </div>
          ) : (
            <ul className="space-y-2">
              {items.map((d) => (
                <DefinitionCard key={d.file} d={d} />
              ))}
            </ul>
          )}
        </>
      )}

      <NewDefinitionDialog open={creating} onOpenChange={setCreating} taken={items.map((d) => d.id)} />
    </div>
  );
}

/** Admin page: Jackett's custom Cardigann definitions. */
export function DefinitionsPage() {
  const search = useSearch({ from: "/definitions" });
  useEffect(() => {
    const prev = document.title;
    document.title = "Свои трекеры · Jackett";
    return () => {
      document.title = prev;
    };
  }, []);
  if (search.edit && validDefinitionId(search.edit)) {
    return <Editor key={search.edit + (search.new ?? "")} id={search.edit} isNew={search.new === "1"} />;
  }
  return <List />;
}
