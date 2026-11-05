import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Loader2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { api, errText, qk, type ConfigField } from "@/api";
import { Callout, ErrorState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

import { ConfigFieldControl } from "./ConfigFieldControl";
import { describeSaveError, isDirty, mergeFormState, toFields, toFormState, type FieldValue, type FormState, type SaveErrorInfo } from "./fields";
import { isVagueError, saveErrorFromLogs } from "./logError";

export interface IndexerConfigPanelProps {
  id: string;
  /** Display name for toasts. */
  title: string;
  /** true when the indexer is not configured yet (saving adds it). */
  isNew?: boolean;
  /** Fetch the config only while true. */
  enabled?: boolean;
  /** Called after a successful save (the indexer is now configured). */
  onSaved?: (indexerId: string) => void;
  /** "Отмена": the owner decides whether to ask first (see onStateChange). */
  onCancel: () => void;
  /** Reports unsaved changes and a running save, for close confirmations. */
  onStateChange?: (s: { dirty: boolean; busy: boolean }) => void;
  /** Extra content above the fields (e.g. tracker description in the catalog). */
  header?: React.ReactNode;
  className?: string;
}

/**
 * The dynamic tracker settings form with its footer. Saving is also how a tracker is added:
 * Jackett logs in to the tracker during save, so save errors are tracker errors.
 * Mount with `key={id}` so each tracker starts with a fresh form.
 */
export function IndexerConfigPanel({ id, title, isNew, enabled = true, onSaved, onCancel, onStateChange, header, className }: IndexerConfigPanelProps) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: qk.indexerConfig(id),
    queryFn: () => api.indexerConfig(id),
    staleTime: 0,
    gcTime: 0,
    enabled,
  });

  const [fields, setFields] = useState<ConfigField[] | null>(null);
  const [state, setState] = useState<FormState>([]);
  const [initial, setInitial] = useState<FormState>([]);
  const [synced, setSynced] = useState<ConfigField[] | undefined>(undefined);
  const [saveError, setSaveError] = useState<SaveErrorInfo | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Sync server data into the form (first load, or a re-fetch for a new captcha that keeps user input).
  if (query.data && query.data !== synced) {
    setSynced(query.data);
    setState(fields ? mergeFormState(fields, state, query.data) : toFormState(query.data));
    setInitial(toFormState(query.data));
    setFields(query.data);
  }

  const dirty = fields !== null && isDirty(initial, state);

  const refetchConfig = () => {
    void query.refetch().then((r) => {
      if (r.error) toast.error(`Не удалось обновить капчу: ${errText(r.error)}`);
    });
  };

  const test = useMutation({
    mutationFn: () => api.testIndexer(id),
    onSuccess: () => toast.success(`${title}: проверка прошла`),
    onError: (err) => toast.error(`${title}: ${errText(err)}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.indexers }),
  });

  const save = useMutation({
    mutationFn: async (payload: ConfigField[]) => {
      const started = Date.now();
      try {
        await api.saveIndexerConfig(id, payload);
      } catch (err) {
        // Jackett sometimes answers a bare 500: its log still has the reason.
        const text = errText(err);
        if (isVagueError(text)) {
          const fromLog = await api
            .logs()
            .then((logs) => saveErrorFromLogs(logs, id, started))
            .catch(() => null);
          if (fromLog) throw new Error(fromLog);
        }
        throw err;
      }
    },
    onSuccess: () => {
      // The saved values are the new baseline (the panel may stay open after a save).
      setInitial(state);
      void queryClient.invalidateQueries({ queryKey: qk.indexers });
      toast.success(isNew ? `${title} добавлен` : `${title}: настройки сохранены`);
      onSaved?.(id);
      // Background check so the user learns early whether search works.
      api
        .testIndexer(id)
        .then(() => toast.success(`${title}: проверка прошла`))
        .catch((err) => toast.error(`${title}: проверка не прошла — ${errText(err)}`))
        .finally(() => void queryClient.invalidateQueries({ queryKey: qk.indexers }));
    },
    onError: (err) => {
      const info = describeSaveError(errText(err));
      setSaveError(info);
      bodyRef.current?.scrollTo?.({ top: 0, behavior: "smooth" });
      // A failed login consumes the captcha: fetch a new one, keeping what the user typed.
      const hasCaptcha = fields?.some((f) => f.type === "displayimage" && !!f.value);
      if (info.captcha || hasCaptcha) refetchConfig();
    },
  });

  const busy = save.isPending;

  useEffect(() => {
    onStateChange?.({ dirty, busy });
  }, [dirty, busy, onStateChange]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!fields || busy) return;
    setSaveError(null);
    save.mutate(toFields(fields, state));
  };

  const setValue = (i: number, v: FieldValue) =>
    setState((s) => {
      const next = [...s];
      next[i] = v;
      return next;
    });

  const formId = `indexer-config-${id}`;

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        {header}
        {saveError && (
          <Callout variant="error" title="Не удалось сохранить" className="mb-4">
            <p className="break-words">{saveError.message}</p>
            {saveError.hint && <p className="mt-1 text-foreground">{saveError.hint}</p>}
          </Callout>
        )}

        {fields ? (
          <form id={formId} onSubmit={onSubmit} className="space-y-4" noValidate>
            {fields.map((f, i) => (
              <ConfigFieldControl
                key={i}
                field={f}
                inputId={`${formId}-f${i}`}
                value={state[i]}
                onChange={(v) => setValue(i, v)}
                disabled={busy}
                onRefreshCaptcha={refetchConfig}
                refreshing={query.isFetching}
              />
            ))}
          </form>
        ) : query.error ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <div className="space-y-4" aria-busy="true" aria-label="Загрузка">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col-reverse gap-2 border-t bg-background px-4 py-3 sm:flex-row sm:items-center sm:px-6">
        {!isNew && (
          <Button
            type="button"
            variant="outline"
            className="sm:mr-auto"
            onClick={() => test.mutate()}
            disabled={test.isPending || busy}
            title="Проверяет сохранённые настройки"
          >
            {test.isPending ? <Loader2 className="animate-spin" /> : <FlaskConical />}
            {test.isPending ? "Проверяю…" : "Проверить"}
          </Button>
        )}
        <div className="flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row">
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Отмена
          </Button>
          <Button type="submit" form={formId} disabled={!fields || busy}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? "Подключаюсь к трекеру…" : isNew ? "Добавить" : "Сохранить"}
          </Button>
        </div>
      </div>
    </div>
  );
}
