import { ExternalLink, Settings2, X } from "lucide-react";
import type { MutableRefObject } from "react";
import { useCallback } from "react";

import type { IndexerSummary } from "@/api";
import { EmptyState } from "@/components/common";
import { IndexerConfigPanel } from "@/components/indexer-config/IndexerConfigPanel";
import { Button } from "@/components/ui/button";
import { LangBadge, TypeBadge } from "@/pages/indexers/badges";
import { hostOf } from "@/pages/indexers/logic";

export type PaneState = { dirty: boolean; busy: boolean };

/**
 * Right-hand column of the trackers page (wide screens): the picked tracker's settings
 * in place of the dialog. Owners keep `state` to ask before leaving unsaved input.
 */
export function IndexerPane({
  ix,
  state,
  onClose,
  onSaved,
}: {
  ix: IndexerSummary | undefined;
  state: MutableRefObject<PaneState>;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const onState = useCallback(
    (s: PaneState) => {
      state.current = s;
    },
    [state],
  );

  return (
    <aside
      className="sticky top-4 flex h-[calc(100dvh-6rem)] min-h-[24rem] flex-col overflow-hidden rounded-lg border bg-card"
      aria-label={ix ? `Настройки: ${ix.name}` : "Настройки трекера"}
    >
      {ix ? (
        <>
          <div className="flex items-start gap-2 border-b px-4 py-3">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <h2 className="truncate text-base font-semibold leading-tight">{ix.name}</h2>
                <LangBadge code={ix.language} />
                <TypeBadge type={ix.type} />
              </div>
              {ix.site_link && (
                <a
                  href={ix.site_link}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex max-w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                >
                  <span className="truncate">{hostOf(ix.site_link)}</span>
                  <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                </a>
              )}
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose} aria-label="Закрыть настройки">
              <X />
            </Button>
          </div>
          <IndexerConfigPanel
            key={ix.id}
            id={ix.id}
            title={ix.name}
            className="flex-1"
            header={ix.description ? <p className="mb-4 text-sm text-muted-foreground">{ix.description}</p> : undefined}
            onStateChange={onState}
            onCancel={onClose}
            onSaved={onSaved}
          />
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState icon={Settings2} title="Выберите трекер" description="Нажмите на трекер слева, чтобы открыть его настройки здесь." />
        </div>
      )}
    </aside>
  );
}
