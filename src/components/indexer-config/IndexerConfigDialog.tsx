import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Loader2 } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { api, errText, qk, type ConfigField } from "@/api";
import { Callout, ConfirmDialog, ErrorState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/misc";

import { ConfigFieldControl } from "./ConfigFieldControl";
import {
  describeSaveError,
  isDirty,
  mergeFormState,
  toFields,
  toFormState,
  type FieldValue,
  type FormState,
  type SaveErrorInfo,
} from "./fields";

export interface IndexerConfigDialogProps {
  /** Indexer id, e.g. "rutracker". `null` = closed. */
  indexerId: string | null;
  /** Display name for the title while the config loads. */
  indexerName?: string;
  /** true when the indexer is not configured yet (dialog acts as "add"). */
  isNew?: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful save (the indexer is now configured). */
  onSaved?: (indexerId: string) => void;
}

/**
 * Dynamic tracker settings form. Saving is also how a tracker is added: Jackett
 * logs in to the tracker during save, so save errors are tracker errors.
 */
export function IndexerConfigDialog(props: IndexerConfigDialogProps) {
  // Keep the last id while the dialog animates out; start a fresh form on every open.
  const [shownId, setShownId] = useState(props.indexerId);
  const [prevId, setPrevId] = useState(props.indexerId);
  const [session, setSession] = useState(0);
  if (props.indexerId !== prevId) {
    setPrevId(props.indexerId);
    if (props.indexerId !== null) {
      setShownId(props.indexerId);
      setSession((s) => s + 1);
    }
  }
  if (shownId === null) return null;
  return <ConfigDialog key={`${shownId}#${session}`} {...props} id={shownId} open={props.indexerId !== null} />;
}

interface ConfigDialogProps extends IndexerConfigDialogProps {
  id: string;
  open: boolean;
}

function ConfigDialog({ id, open, indexerName, isNew, onOpenChange, onSaved }: ConfigDialogProps) {
  const queryClient = useQueryClient();
  const title = indexerName || id;

  const query = useQuery({
    queryKey: qk.indexerConfig(id),
    queryFn: () => api.indexerConfig(id),
    staleTime: 0,
    gcTime: 0,
    enabled: open,
  });

  const [fields, setFields] = useState<ConfigField[] | null>(null);
  const [state, setState] = useState<FormState>([]);
  const [initial, setInitial] = useState<FormState>([]);
  const [synced, setSynced] = useState<ConfigField[] | undefined>(undefined);
  const [saveError, setSaveError] = useState<SaveErrorInfo | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
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
    mutationFn: (payload: ConfigField[]) => api.saveIndexerConfig(id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.indexers });
      toast.success(isNew ? `${title} добавлен` : `${title}: настройки сохранены`);
      onSaved?.(id);
      onOpenChange(false);
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

  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmClose(true);
    else onOpenChange(false);
  };

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
    <>
      <Dialog open={open} onOpenChange={(o) => (o ? undefined : requestClose())}>
        <DialogContent
          className="flex h-[100dvh] max-h-[100dvh] w-full max-w-none flex-col gap-0 rounded-none p-0 sm:h-auto sm:max-h-[90vh] sm:w-[calc(100%-2rem)] sm:max-w-2xl sm:rounded-lg"
          onInteractOutside={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <DialogHeader className="border-b px-4 py-4 pr-12 text-left sm:px-6">
            <DialogTitle className="truncate leading-tight">{title}</DialogTitle>
            <DialogDescription>{isNew ? "Новый трекер" : "Настройки трекера"}</DialogDescription>
          </DialogHeader>

          <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
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
              <Button type="button" variant="outline" onClick={requestClose} disabled={busy}>
                Отмена
              </Button>
              <Button type="submit" form={formId} disabled={!fields || busy}>
                {busy && <Loader2 className="animate-spin" />}
                {busy ? "Подключаюсь к трекеру…" : "Сохранить"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title="Закрыть без сохранения?"
        description="Введённые изменения пропадут."
        confirmLabel="Закрыть"
        destructive
        onConfirm={() => {
          setConfirmClose(false);
          onOpenChange(false);
        }}
      />
    </>
  );
}
