import { useState } from "react";

import { ConfirmDialog } from "@/components/common";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { IndexerConfigPanel } from "./IndexerConfigPanel";

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
  const title = indexerName || id;
  const [confirmClose, setConfirmClose] = useState(false);
  const [st, setSt] = useState({ dirty: false, busy: false });

  const requestClose = () => {
    if (st.busy) return;
    if (st.dirty) setConfirmClose(true);
    else onOpenChange(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => (o ? undefined : requestClose())}>
        <DialogContent
          className="flex h-[100dvh] max-h-[100dvh] w-full max-w-none flex-col gap-0 rounded-none p-0 sm:h-auto sm:max-h-[90vh] sm:w-[calc(100%-2rem)] sm:max-w-2xl sm:rounded-lg"
          onInteractOutside={(e) => {
            if (st.busy) e.preventDefault();
          }}
        >
          <DialogHeader className="border-b px-4 py-4 pr-12 text-left sm:px-6">
            <DialogTitle className="truncate leading-tight">{title}</DialogTitle>
            <DialogDescription>{isNew ? "Новый трекер" : "Настройки трекера"}</DialogDescription>
          </DialogHeader>
          <IndexerConfigPanel
            id={id}
            title={title}
            isNew={isNew}
            enabled={open}
            className="flex-1"
            onCancel={requestClose}
            onStateChange={setSt}
            onSaved={(saved) => {
              onSaved?.(saved);
              onOpenChange(false);
            }}
          />
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
