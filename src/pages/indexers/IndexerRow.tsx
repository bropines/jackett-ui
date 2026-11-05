import { CheckCircle2, ExternalLink, Link2, Loader2, MoreVertical, Pencil, Play, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { torznabUrl, type IndexerSummary } from "@/api";
import { copyText } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/misc";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { LangBadge, TypeBadge } from "@/pages/indexers/badges";
import { effectiveStatus, firstLine, hostOf, type TestState } from "@/pages/indexers/logic";

async function copyWithToast(text: string, what: string) {
  if (!text) {
    toast.error(`${what}: пока нет данных`);
    return;
  }
  if (await copyText(text)) toast.success(`${what} скопирован`);
  else toast.error("Не удалось скопировать");
}

export function IndexerRow({
  ix,
  test,
  canManage,
  onTest,
  onEdit,
  onDelete,
  selected,
  onSelect,
}: {
  ix: IndexerSummary;
  test: TestState | undefined;
  /** Editors and admins: test / configure / delete. Viewers see the list read-only. */
  canManage: boolean;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** Multi-select checkbox state. */
  selected: boolean;
  onSelect: (checked: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = effectiveStatus(ix, test);
  const running = status.kind === "running";
  const error = status.kind === "error" ? status.error : "";
  const short = error ? firstLine(error, 200) : "";
  const canExpand = error !== "" && (error.trim() !== short || short.length > 100);

  return (
    <li className={cn("flex gap-3 px-4 py-3", selected && "bg-primary/5")}>
      <div className="flex items-start gap-3 pt-1">
        <Checkbox className="h-5 w-5 sm:h-4 sm:w-4" checked={selected} onCheckedChange={(v) => onSelect(v === true)} aria-label={`Выбрать ${ix.name}`} />
        {running ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Проверка" />
        ) : status.kind === "ok" ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-label="Работает" />
        ) : (
          <XCircle className="h-4 w-4 text-destructive" aria-label="Ошибка" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {canManage ? (
            <button
              type="button"
              className="min-w-0 truncate text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={onEdit}
              title={ix.description || ix.name}
            >
              {ix.name}
            </button>
          ) : (
            <span className="min-w-0 truncate font-medium" title={ix.description || ix.name}>
              {ix.name}
            </span>
          )}
          <LangBadge code={ix.language} />
          <TypeBadge type={ix.type} />
          {ix.tags.map((t) => (
            <span key={t} className="rounded bg-muted px-1.5 text-[11px] leading-5 text-muted-foreground">
              #{t}
            </span>
          ))}
        </div>

        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          {ix.site_link && (
            <a
              href={ix.site_link}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex shrink-0 items-center gap-1 hover:text-foreground hover:underline"
            >
              {hostOf(ix.site_link)}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          )}
          {ix.description && (
            <span className="hidden min-w-0 truncate md:inline" title={ix.description}>
              · {ix.description}
            </span>
          )}
        </div>

        <div className="mt-1 text-xs" aria-live="polite">
          {running ? (
            <span className="text-muted-foreground">Проверяю…</span>
          ) : status.kind === "ok" ? (
            <span className="text-emerald-700 dark:text-emerald-400">{status.tested ? "Проверка прошла" : "Работает"}</span>
          ) : (
            <div className="text-red-700 dark:text-red-400">
              <span className={cn("break-words", !expanded && "line-clamp-2")}>
                {status.tested ? "Проверка не прошла: " : "Последняя ошибка: "}
                {expanded ? null : short}
              </span>
              {expanded && <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-destructive/5 p-2 font-mono text-[11px]">{error}</pre>}
              {canExpand && (
                <button
                  type="button"
                  className="ml-1 underline-offset-2 hover:underline"
                  onClick={() => setExpanded(!expanded)}
                  aria-expanded={expanded}
                >
                  {expanded ? "Свернуть" : "Подробнее"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-start gap-1">
        {canManage && (
          <>
            <Button variant="outline" size="sm" className="hidden sm:inline-flex" disabled={running} onClick={onTest}>
              {running ? <Loader2 className="animate-spin" /> : <Play />}
              Проверить
            </Button>
            <Button variant="outline" size="sm" className="hidden sm:inline-flex" onClick={onEdit}>
              <Pencil />
              Настроить
            </Button>
          </>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Действия: ${ix.name}`}>
              <MoreVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {canManage && (
              <>
                <DropdownMenuItem className="sm:hidden" disabled={running} onSelect={onTest}>
                  <Play />
                  Проверить
                </DropdownMenuItem>
                <DropdownMenuItem className="sm:hidden" onSelect={onEdit}>
                  <Pencil />
                  Настроить
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem onSelect={() => void copyWithToast(torznabUrl(ix.id), "Torznab-адрес")}>
              <Link2 />
              Копировать Torznab-адрес
            </DropdownMenuItem>
            {ix.site_link && (
              <DropdownMenuItem asChild>
                <a href={ix.site_link} target="_blank" rel="noreferrer noopener">
                  <ExternalLink />
                  Открыть сайт
                </a>
              </DropdownMenuItem>
            )}
            {canManage && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
                  <Trash2 />
                  Удалить
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}
