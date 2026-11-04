import { Link } from "@tanstack/react-router";
import { ChevronDown, KeyRound, Puzzle } from "lucide-react";

import { CopyField } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useLocalState } from "@/lib/hooks";
import { cn } from "@/lib/utils";

/**
 * Collapsible help for qBittorrent's built-in "Jackett" search plugin and Torznab clients.
 * The API key is the user's personal token (profile), never Jackett's own key.
 */
export function QbitHelp() {
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
        <span className="min-w-0 flex-1 font-medium">Поиск из qBittorrent, Sonarr, Radarr</span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-3 border-t px-4 pb-4 pt-3 text-sm">
          <p className="text-muted-foreground">
            В qBittorrent включите поиск (Вид → Поисковик), установите плагин «Jackett» и укажите в его настройках адрес и API-ключ. В
            Sonarr / Radarr добавьте индексатор Torznab с адресом трекера (меню трекера → «Копировать Torznab-адрес») и тем же ключом.
          </p>
          <div className="min-w-0 space-y-1">
            <div className="text-xs text-muted-foreground">Адрес Jackett</div>
            <CopyField value={origin} label="Копировать адрес" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">API-ключ — ваш личный токен. Создайте его в профиле:</span>
            <Button asChild variant="outline" size="sm">
              <Link to="/profile" hash="tokens">
                <KeyRound /> Мои API-токены
              </Link>
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
