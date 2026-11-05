import { CheckCircle2, Circle, Loader2, MinusCircle, Settings2, Square, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { countByStatus, type AddItem, type AddStatus } from "@/pages/indexers/selection";

const STATUS_TEXT: Record<AddStatus, string> = {
  pending: "В очереди",
  running: "Добавляю…",
  added: "Добавлен",
  failed: "Ошибка",
  setup: "Нужно настроить",
  skipped: "Пропущен",
};

function StatusIcon({ status }: { status: AddStatus }) {
  const cls = "h-4 w-4 shrink-0";
  switch (status) {
    case "running":
      return <Loader2 className={`${cls} animate-spin text-muted-foreground`} aria-hidden />;
    case "added":
      return <CheckCircle2 className={`${cls} text-emerald-600 dark:text-emerald-400`} aria-hidden />;
    case "failed":
      return <XCircle className={`${cls} text-destructive`} aria-hidden />;
    case "setup":
      return <Settings2 className={`${cls} text-amber-600 dark:text-amber-400`} aria-hidden />;
    case "skipped":
      return <MinusCircle className={`${cls} text-muted-foreground`} aria-hidden />;
    default:
      return <Circle className={`${cls} text-muted-foreground/50`} aria-hidden />;
  }
}

/** Progress and result summary of adding several trackers at once. */
export function BulkAddDialog({
  open,
  items,
  running,
  onStop,
  onClose,
  onSetup,
}: {
  open: boolean;
  items: AddItem[];
  running: boolean;
  onStop: () => void;
  onClose: () => void;
  /** Opens the config dialog for the trackers that need input, one by one. */
  onSetup: () => void;
}) {
  const c = countByStatus(items);
  const done = items.length - c.pending - c.running;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !running && onClose()}>
      <DialogContent
        className="flex max-h-[90dvh] flex-col sm:max-w-lg"
        onInteractOutside={(e) => running && e.preventDefault()}
        onEscapeKeyDown={(e) => running && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{running ? "Добавляю трекеры" : "Готово"}</DialogTitle>
          <DialogDescription aria-live="polite">
            {running
              ? `${done} из ${items.length}`
              : [
                  c.added && `добавлено: ${c.added}`,
                  c.setup && `нужно настроить: ${c.setup}`,
                  c.failed && `с ошибкой: ${c.failed}`,
                  c.skipped && `пропущено: ${c.skipped}`,
                ]
                  .filter(Boolean)
                  .join(" · ") || "Ничего не добавлено"}
          </DialogDescription>
        </DialogHeader>

        {running && (
          <div className="h-1.5 overflow-hidden rounded bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Прогресс">
            <div className="h-full rounded bg-primary transition-[width]" style={{ width: `${pct}%` }} />
          </div>
        )}

        <ul className="-mx-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1 text-sm" aria-label="Трекеры">
          {items.map((it) => (
            <li key={it.id} className="flex items-start gap-2 rounded px-1 py-1">
              <span className="pt-0.5">
                <StatusIcon status={it.status} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-medium">{it.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{STATUS_TEXT[it.status]}</span>
                </div>
                {it.error && <p className="mt-0.5 break-words text-xs text-red-700 dark:text-red-400">{it.error}</p>}
              </div>
            </li>
          ))}
        </ul>

        <DialogFooter className="gap-2 sm:gap-0">
          {running ? (
            <Button variant="outline" onClick={onStop}>
              <Square className="fill-current" />
              Остановить
            </Button>
          ) : (
            <>
              <Button variant={c.setup ? "outline" : "default"} onClick={onClose}>
                Закрыть
              </Button>
              {c.setup > 0 && (
                <Button onClick={onSetup}>
                  <Settings2 />
                  Настроить ({c.setup})
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
