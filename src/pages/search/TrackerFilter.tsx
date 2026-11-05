import { Bookmark, BookmarkPlus, ChevronDown, Server, Trash2, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";

import type { IndexerSummary } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { commitDraft, draftFromSelection, onlyShown, splitChips, toggle } from "./logic";
import { applicableTrackers, loadPresets, presetMatches, removePreset, savePresets, upsertPreset, type TrackerPreset } from "./presets";

/** Chips shown next to the button before collapsing into "+N". */
const MAX_CHIPS = 3;

/**
 * Multi-select of configured trackers. Edits a draft while open and commits it on
 * close, so ticking five boxes runs one search, not five. Empty selection = all.
 * Chosen trackers show as removable chips; saved groups live in localStorage.
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
  const allIds = useMemo(() => indexers.map((i) => i.id), [indexers]);
  const [draft, setDraft] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [presets, setPresets] = useState<TrackerPreset[]>(() => loadPresets());
  const [naming, setNaming] = useState<string | null>(null);
  const inputId = useId();

  const names = useMemo(() => new Map(indexers.map((i) => [i.id, i.name])), [indexers]);
  // Until the list loads, show the URL selection as is.
  const chosen = useMemo(() => (names.size === 0 ? selected : selected.filter((id) => names.has(id))), [selected, names]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? indexers.filter((i) => i.name.toLowerCase().includes(f) || i.id.includes(f)) : indexers;
  }, [indexers, filter]);

  const commit = (ids: string[]) => {
    const next = commitDraft(ids, allIds);
    if (next.join(",") !== selected.join(",")) onChange(next);
  };

  const onOpenChange = (next: boolean) => {
    if (next) {
      setDraft(draftFromSelection(selected, allIds));
      setFilter("");
      setNaming(null);
    } else {
      commit(draft);
    }
    setOpen(next);
  };

  const storePresets = (list: TrackerPreset[]) => {
    setPresets(list);
    if (!savePresets(list)) toast.error("Браузер не дал сохранить группу");
  };

  const applyPreset = (p: TrackerPreset) => {
    const ids = applicableTrackers(p, allIds);
    if (ids.length === 0) {
      toast.error(`В группе «${p.name}» нет подключённых трекеров`);
      return;
    }
    setDraft(ids);
    commit(ids);
    setOpen(false);
  };

  const savePreset = () => {
    const name = (naming ?? "").trim();
    const ids = allIds.filter((id) => draft.includes(id));
    if (!name || ids.length === 0) return;
    storePresets(upsertPreset(presets, name, ids));
    setNaming(null);
    toast.success(`Группа «${name}» сохранена`);
  };

  const label =
    chosen.length === 0 ? "Все трекеры" : chosen.length === 1 ? (names.get(chosen[0] ?? "") ?? chosen[0]) : `Трекеры: ${chosen.length}`;
  const activePreset = chosen.length > 0 ? presets.find((p) => presetMatches(p, chosen, allIds)) : undefined;
  const chips = splitChips(chosen, MAX_CHIPS);
  const removeChip = (id: string) => onChange(chosen.filter((x) => x !== id));
  const draftCount = draft.length;

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            className={cn("max-w-[14rem]", chosen.length > 0 && "border-primary/50 bg-primary/5")}
            aria-label={`Фильтр трекеров: ${activePreset ? `группа ${activePreset.name}` : label}`}
          >
            {activePreset ? <Bookmark /> : <Server />}
            <span className="truncate">{activePreset ? activePreset.name : label}</span>
            <ChevronDown className="opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-0">
          {presets.length > 0 && (
            <div className="border-b p-2">
              <p className="mb-1 px-1 text-xs text-muted-foreground">Группы</p>
              <ul className="flex flex-wrap gap-1" aria-label="Сохранённые группы">
                {presets.map((p) => (
                  <li key={p.id} className="flex items-center rounded-full border bg-background text-xs">
                    <button
                      type="button"
                      className="max-w-[10rem] truncate rounded-l-full py-0.5 pl-2.5 pr-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      onClick={() => applyPreset(p)}
                      title={p.trackers.map((id) => names.get(id) ?? id).join(", ")}
                    >
                      {p.name} <span className="text-muted-foreground">{applicableTrackers(p, allIds).length}</span>
                    </button>
                    <button
                      type="button"
                      className="rounded-r-full py-0.5 pl-0.5 pr-1.5 text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      onClick={() => storePresets(removePreset(presets, p.id))}
                      aria-label={`Удалить группу ${p.name}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

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

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs">
            <span className="mr-auto text-muted-foreground" aria-live="polite">
              {draftCount === 0
                ? "ничего не выбрано: искать везде"
                : draftCount === allIds.length
                  ? `все (${allIds.length})`
                  : `выбрано ${draftCount} из ${allIds.length}`}
            </span>
            {draftCount < allIds.length && (
              <button type="button" className="text-primary hover:underline" onClick={() => setDraft([...allIds])}>
                Выбрать все
              </button>
            )}
            {draftCount > 0 && (
              <button type="button" className="text-primary hover:underline" onClick={() => setDraft([])}>
                Снять все
              </button>
            )}
            {filter.trim() !== "" && shown.length > 0 && (
              <button type="button" className="text-primary hover:underline" onClick={() => setDraft(onlyShown(shown))}>
                Только эти ({shown.length})
              </button>
            )}
          </div>

          <ul className="max-h-64 overflow-y-auto p-1" role="listbox" aria-multiselectable aria-label="Трекеры">
            {shown.length === 0 && <li className="px-2 py-3 text-center text-sm text-muted-foreground">Не найдено</li>}
            {shown.map((i) => {
              const checked = draft.includes(i.id);
              const boxId = `${inputId}-${i.id}`;
              return (
                <li key={i.id} role="option" aria-selected={checked}>
                  <label
                    htmlFor={boxId}
                    className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    <Checkbox id={boxId} checked={checked} onCheckedChange={() => setDraft(toggle(draft, i.id))} />
                    <span className="min-w-0 flex-1 truncate">{i.name}</span>
                    {i.last_error && <span className="h-2 w-2 shrink-0 rounded-full bg-destructive" title="Последний запрос с ошибкой" />}
                    <button
                      type="button"
                      className="shrink-0 text-xs text-muted-foreground hover:text-foreground focus:opacity-100 sm:opacity-0 [li:hover_&]:opacity-100"
                      onClick={(e) => {
                        e.preventDefault();
                        setDraft([i.id]);
                      }}
                      aria-label={`Только ${i.name}`}
                    >
                      только
                    </button>
                  </label>
                </li>
              );
            })}
          </ul>

          <div className="border-t p-2">
            {naming === null ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-full justify-start text-xs"
                disabled={draftCount === 0 || draftCount === allIds.length}
                title={draftCount === 0 || draftCount === allIds.length ? "Сначала отметьте нужные трекеры" : undefined}
                onClick={() => setNaming(activePreset?.name ?? "")}
              >
                <BookmarkPlus />
                Сохранить как группу
              </Button>
            ) : (
              <form
                className="flex gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  savePreset();
                }}
              >
                <Input
                  value={naming}
                  onChange={(e) => setNaming(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setNaming(null);
                    }
                  }}
                  placeholder="Название группы"
                  aria-label="Название группы"
                  maxLength={60}
                  className="h-7 text-xs"
                  autoFocus
                />
                <Button type="submit" size="sm" className="h-7 shrink-0 text-xs" disabled={!naming.trim()}>
                  Сохранить
                </Button>
              </form>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {chips.shown.map((id) => (
        <Chip key={id} label={names.get(id) ?? id} onRemove={() => removeChip(id)} disabled={disabled} />
      ))}
      {chips.hidden.length > 0 && (
        <button
          type="button"
          className="h-7 shrink-0 rounded-full border bg-background px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => onOpenChange(true)}
          disabled={disabled}
          title={chips.hidden.map((id) => names.get(id) ?? id).join(", ")}
          aria-label={`Ещё ${chips.hidden.length}: показать все выбранные трекеры`}
        >
          +{chips.hidden.length}
        </button>
      )}
      {chosen.length > 1 && (
        <button
          type="button"
          className="h-7 shrink-0 px-1.5 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => onChange([])}
          disabled={disabled}
          title="Искать на всех трекерах"
        >
          Все
        </button>
      )}
    </div>
  );
}

function Chip({ label, onRemove, disabled }: { label: string; onRemove: () => void; disabled?: boolean }) {
  return (
    <span className="inline-flex h-7 max-w-[9rem] shrink-0 items-center gap-0.5 rounded-full border border-primary/40 bg-primary/5 pl-2.5 pr-1 text-xs">
      <span className="truncate">{label}</span>
      <button
        type="button"
        className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`Убрать ${label}`}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
