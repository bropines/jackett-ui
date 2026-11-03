import { ChevronDown, Puzzle } from "lucide-react";

import { CopyButton, CopyField } from "@/components/common";
import { Card } from "@/components/ui/card";
import { useLocalState } from "@/lib/hooks";
import { cn } from "@/lib/utils";

/** Jackett plugin config for qBittorrent's search engine (nova3/engines/jackett.json). */
export function qbitPluginJson(url: string, apiKey: string): string {
  return JSON.stringify({ api_key: apiKey, thread_count: 20, tracker_first: false, url }, null, 4);
}

/** Collapsible help for qBittorrent's built-in "Jackett" search plugin. */
export function QbitHelp({ apiKey }: { apiKey: string }) {
  const [open, setOpen] = useLocalState("jackett-ui.indexers.qbit-help", false);
  const origin = window.location.origin;
  return (
    <Card className="mb-4 shadow-none">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-xl px-4 py-2.5 text-left text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Puzzle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 font-medium">Поиск из qBittorrent</span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-3 border-t px-4 pb-4 pt-3 text-sm">
          <p className="text-muted-foreground">
            В qBittorrent включите поиск (Вид → Поисковик), установите плагин «Jackett» и укажите в его настройках
            адрес и API-ключ:
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="min-w-0 space-y-1">
              <div className="text-xs text-muted-foreground">Адрес Jackett</div>
              <CopyField value={origin} label="Копировать адрес" />
            </div>
            <div className="min-w-0 space-y-1">
              <div className="text-xs text-muted-foreground">API-ключ</div>
              {apiKey ? (
                <CopyField value={apiKey} label="Копировать API-ключ" />
              ) : (
                <div className="rounded-md border px-3 py-2 text-muted-foreground">Загрузка…</div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              Или замените файл <code className="rounded bg-muted px-1">nova3/engines/jackett.json</code> в папке
              данных qBittorrent:
            </span>
            <CopyButton value={() => qbitPluginJson(origin, apiKey)} label="Копировать jackett.json" withText />
          </div>
        </div>
      )}
    </Card>
  );
}
