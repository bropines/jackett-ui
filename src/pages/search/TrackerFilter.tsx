import { ChevronDown, Server } from "lucide-react";
import { useId, useMemo, useState } from "react";

import type { IndexerSummary } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { toggle } from "./logic";

/**
 * Multi-select of configured trackers. Edits a draft while open and commits it on
 * close, so ticking five boxes runs one search, not five. Empty selection = all.
 */
export function TrackerFilter({
  indexers,
  selected,
  onChange,
  disabled,
}: {
  indexers: IndexerSummary[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(selected);
  const [filter, setFilter] = useState("");
  const inputId = useId();

  const all = draft.length === 0;
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? indexers.filter((i) => i.name.toLowerCase().includes(f) || i.id.includes(f)) : indexers;
  }, [indexers, filter]);

  const onOpenChange = (next: boolean) => {
    if (next) {
      setDraft(selected);
      setFilter("");
    } else {
      // All boxes ticked = default "all".
      const commit = draft.length === indexers.length ? [] : draft;
      if (commit.join(",") !== selected.join(",")) onChange(commit);
    }
    setOpen(next);
  };

  const names = new Map(indexers.map((i) => [i.id, i.name]));
  const label =
    selected.length === 0
      ? "Все трекеры"
      : selected.length === 1
        ? (names.get(selected[0] ?? "") ?? selected[0])
        : `Трекеры: ${selected.length}`;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn("max-w-[14rem]", selected.length > 0 && "border-primary/50 bg-primary/5")}
          aria-label={`Фильтр трекеров: ${label}`}
        >
          <Server />
          <span className="truncate">{label}</span>
          <ChevronDown className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="border-b p-2">
          <label htmlFor={inputId} className="sr-only">
            Найти трекер
          </label>
          <Input
            id={inputId}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Найти трекер"
            className="h-8"
            autoFocus
          />
        </div>
        <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs">
          <span className="text-muted-foreground">{all ? `все (${indexers.length})` : `выбрано ${draft.length} из ${indexers.length}`}</span>
          {!all && (
            <button type="button" className="text-primary hover:underline" onClick={() => setDraft([])}>
              Выбрать все
            </button>
          )}
        </div>
        <ul className="max-h-72 overflow-y-auto p-1" role="listbox" aria-multiselectable aria-label="Трекеры">
          {shown.length === 0 && <li className="px-2 py-3 text-center text-sm text-muted-foreground">Не найдено</li>}
          {shown.map((i) => {
            const checked = all || draft.includes(i.id);
            const boxId = `${inputId}-${i.id}`;
            return (
              <li key={i.id} role="option" aria-selected={checked}>
                <label
                  htmlFor={boxId}
                  className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                >
                  <Checkbox
                    id={boxId}
                    checked={checked}
                    onCheckedChange={() =>
                      // From "all", unticking one selects every other tracker.
                      setDraft(all ? indexers.map((x) => x.id).filter((id) => id !== i.id) : toggle(draft, i.id))
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{i.name}</span>
                  {i.last_error && <span className="h-2 w-2 shrink-0 rounded-full bg-destructive" title="Последний запрос с ошибкой" />}
                  <button
                    type="button"
                    className="shrink-0 text-xs text-muted-foreground hover:text-foreground focus:opacity-100 sm:opacity-0 [li:hover_&]:opacity-100"
                    onClick={(e) => {
                      e.preventDefault();
                      setDraft([i.id]);
                    }}
                  >
                    только
                  </button>
                </label>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
