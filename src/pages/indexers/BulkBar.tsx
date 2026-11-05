import { Link2, ListChecks, Loader2, Square, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Sticky action bar for the selected trackers. */
export function BulkBar({
  count,
  canManage,
  testing,
  onTest,
  onStopTest,
  onDelete,
  onCopy,
  onClear,
}: {
  count: number;
  /** Editors and admins: test and delete. */
  canManage: boolean;
  /** Progress of a running bulk test, or null. */
  testing: { done: number; total: number } | null;
  onTest: () => void;
  onStopTest: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onClear: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Действия с выбранными трекерами"
      className="sticky bottom-2 z-20 mt-3 flex flex-wrap items-center gap-1.5 rounded-lg border bg-background/95 p-2 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:bottom-4"
    >
      <span className="mr-auto px-1.5 text-sm font-medium" aria-live="polite">
        Выбрано: {count}
      </span>
      {canManage &&
        (testing ? (
          <Button variant="outline" size="sm" onClick={onStopTest} title="Остановить проверку">
            <Loader2 className="animate-spin" />
            {testing.done} / {testing.total}
            <Square className="ml-1 fill-current" aria-label="Остановить" />
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={onTest}>
            <ListChecks />
            Проверить
          </Button>
        ))}
      <Button variant="outline" size="sm" onClick={onCopy} title="Копировать Torznab-адреса, по одному на строку">
        <Link2 />
        <span className="sm:hidden">Torznab</span>
        <span className="hidden sm:inline">Копировать Torznab-адреса</span>
      </Button>
      {canManage && (
        <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={onDelete} disabled={testing !== null}>
          <Trash2 />
          Удалить
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onClear} aria-label="Снять выделение" title="Снять выделение">
        <X />
        <span className="hidden sm:inline">Снять выделение</span>
      </Button>
    </div>
  );
}
