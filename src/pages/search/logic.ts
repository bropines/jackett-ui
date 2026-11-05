/** Pure helpers of the search page (URL params, formatting, filtering). Unit-tested in logic.test.ts. */
import type { SearchResult } from "@/api";

/* ── Categories ─────────────────────────────────────────────────────────── */

/** Main Torznab categories. Jackett matches subcategories (+10..+90) of a main id itself. */
export const MAIN_CATEGORIES: { id: number; name: string }[] = [
  { id: 2000, name: "Фильмы" },
  { id: 5000, name: "Сериалы" },
  { id: 3000, name: "Музыка" },
  { id: 7000, name: "Книги" },
  { id: 4000, name: "Программы" },
  { id: 1000, name: "Игры" },
  { id: 6000, name: "XXX" },
  { id: 8000, name: "Другое" },
];

const CATEGORY_NAME = new Map(MAIN_CATEGORIES.map((c) => [c.id, c.name]));

/** Category label of a result: Jackett's CategoryDesc, else the main category of the first standard id. */
export function categoryLabel(r: Pick<SearchResult, "CategoryDesc" | "Category">): string {
  if (r.CategoryDesc) return r.CategoryDesc;
  const std = r.Category?.find((id) => id < 100000);
  if (std == null) return "";
  return CATEGORY_NAME.get(Math.floor(std / 1000) * 1000) ?? String(std);
}

/* ── URL params ─────────────────────────────────────────────────────────── */

/** "a,b,,a" → ["a","b"] (trimmed, unique, in order). */
export function parseIdList(v: string | undefined): string[] {
  if (!v) return [];
  const out: string[] = [];
  for (const raw of v.split(",")) {
    const s = raw.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Category ids from the `c` param: positive integers only, unique, sorted. */
export function parseCategories(v: string | undefined): number[] {
  const ids = parseIdList(v)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** Serialises a list for the URL; empty → undefined (param dropped). Sorted so equal selections give equal URLs. */
export function joinIds(ids: readonly (string | number)[]): string | undefined {
  if (ids.length === 0) return undefined;
  const strs = [...new Set(ids.map(String))];
  const allNumeric = strs.every((s) => /^\d+$/.test(s));
  strs.sort(allNumeric ? (a, b) => Number(a) - Number(b) : undefined);
  return strs.join(",");
}

/**
 * Tracker selection for the URL. Selecting every configured tracker (or none) means
 * "all", which is the default and is not written to the URL.
 */
export function trackersParam(selected: readonly string[], configured: readonly string[]): string | undefined {
  if (selected.length === 0) return undefined;
  if (configured.length > 0 && configured.every((id) => selected.includes(id))) return undefined;
  return joinIds(selected);
}

export function toggle<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/* ── Tracker filter draft ───────────────────────────────────────────────── */

/**
 * The tracker popover edits an explicit list of ticked ids. An empty URL selection
 * means "all", so it opens with every tracker ticked; unknown ids are dropped.
 */
export function draftFromSelection(selected: readonly string[], all: readonly string[]): string[] {
  const known = selected.filter((id) => all.includes(id));
  return known.length === 0 ? [...all] : known;
}

/** Draft → selection to commit: nothing or everything ticked = "all" (empty); otherwise ids in list order. */
export function commitDraft(draft: readonly string[], all: readonly string[]): string[] {
  const picked = all.filter((id) => draft.includes(id));
  return picked.length === 0 || picked.length === all.length ? [] : picked;
}

/** "Only these": keeps just the ids currently shown by the quick filter. */
export function onlyShown(shown: readonly { id: string }[]): string[] {
  return shown.map((x) => x.id);
}

/** Chips next to the filter button: first `max` shown, the rest collapsed into "+N". */
export function splitChips<T>(items: readonly T[], max: number): { shown: T[]; hidden: T[] } {
  if (items.length <= max) return { shown: [...items], hidden: [] };
  // Showing "+1" instead of the last chip saves nothing: collapse at least two.
  const keep = Math.max(0, max - 1);
  return { shown: items.slice(0, keep), hidden: items.slice(keep) };
}

/* ── Formatting ─────────────────────────────────────────────────────────── */

const SIZE_UNITS = ["Б", "КБ", "МБ", "ГБ", "ТБ", "ПБ"];

/** Bytes → "4,4 ГБ" (binary: 1 ГБ = 1024³ Б, as qBittorrent/Windows show it). */
export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < SIZE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 || v >= 100 ? 0 : 1;
  return `${v.toLocaleString("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${SIZE_UNITS[i]}`;
}

/** Milliseconds → "230 мс" / "1,4 с" / "12 с". */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} мс`;
  const s = ms / 1000;
  return `${s.toLocaleString("ru-RU", { maximumFractionDigits: s < 10 ? 1 : 0 })} с`;
}

export type SeedTone = "none" | "dead" | "low" | "good";

/** Seeder health: 0 dead (red), 1–4 low (amber), 5+ good (green). */
export function seedTone(seeders: number | null | undefined): SeedTone {
  if (seeders == null) return "none";
  if (seeders <= 0) return "dead";
  if (seeders < 5) return "low";
  return "good";
}

export const SEED_TONE_CLASS: Record<SeedTone, string> = {
  none: "text-muted-foreground",
  dead: "text-red-600 dark:text-red-400",
  low: "text-amber-600 dark:text-amber-400",
  good: "text-emerald-600 dark:text-emerald-400",
};

/** First non-empty line of a (possibly multi-line .NET stack trace) error. */
export function firstLine(text: string | null | undefined): string {
  if (!text) return "";
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  return line.trim();
}

/* ── Rows ───────────────────────────────────────────────────────────────── */

export interface ResultRow {
  /** Unique within one response (Guid can repeat across trackers). */
  id: string;
  r: SearchResult;
  category: string;
  /** Lower-cased text the client filter matches against. */
  haystack: string;
  /** Epoch ms or null (Jackett uses 0001-01-01 for "unknown"). */
  published: number | null;
}

export function parseDate(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t) || new Date(t).getFullYear() < 1990) return null;
  return t;
}

export function toRows(results: readonly SearchResult[]): ResultRow[] {
  return results.map((r, i) => {
    const category = categoryLabel(r);
    return {
      id: `${r.TrackerId}|${r.Guid}|${i}`,
      r,
      category,
      haystack: `${r.Title} ${r.Tracker} ${category}`.toLowerCase(),
      published: parseDate(r.PublishDate),
    };
  });
}

/**
 * Client-side filter: every word must occur in title/tracker/category; a word
 * starting with "-" excludes rows containing it. Case-insensitive.
 */
export function filterRows(rows: readonly ResultRow[], filter: string, tracker?: string | null): ResultRow[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const include = words.filter((w) => !w.startsWith("-"));
  const exclude = words.filter((w) => w.startsWith("-") && w.length > 1).map((w) => w.slice(1));
  if (include.length === 0 && exclude.length === 0 && !tracker) return rows as ResultRow[];
  return rows.filter(
    (row) =>
      (!tracker || row.r.TrackerId === tracker) &&
      include.every((w) => row.haystack.includes(w)) &&
      !exclude.some((w) => row.haystack.includes(w)),
  );
}

/* ── Sorting ────────────────────────────────────────────────────────────── */

export type SortKey = "title" | "tracker" | "category" | "size" | "seeders" | "peers" | "published";

export const SORT_LABELS: Record<SortKey, string> = {
  seeders: "Сиды",
  size: "Размер",
  published: "Дата",
  title: "Название",
  peers: "Пиры",
  tracker: "Трекер",
  category: "Категория",
};

/** Sort value of a row; null sorts last in both directions. */
export function sortValue(row: ResultRow, key: SortKey): string | number | null {
  switch (key) {
    case "title":
      return row.r.Title.toLowerCase();
    case "tracker":
      return row.r.Tracker.toLowerCase();
    case "category":
      return row.category.toLowerCase() || null;
    case "size":
      return row.r.Size;
    case "seeders":
      return row.r.Seeders;
    case "peers":
      return row.r.Peers;
    case "published":
      return row.published;
  }
}

const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });

/** Stable sort by `key`; nulls last regardless of direction; ties keep the original (relevance) order. */
export function sortRows(rows: readonly ResultRow[], key: SortKey, desc: boolean): ResultRow[] {
  const dir = desc ? -1 : 1;
  return rows
    .map((row, i) => ({ row, i, v: sortValue(row, key) }))
    .sort((a, b) => {
      if (a.v == null || b.v == null) {
        if (a.v == null && b.v == null) return a.i - b.i;
        return a.v == null ? 1 : -1;
      }
      const c = typeof a.v === "number" && typeof b.v === "number" ? a.v - b.v : collator.compare(String(a.v), String(b.v));
      return c !== 0 ? c * dir : a.i - b.i;
    })
    .map((x) => x.row);
}

/** Numbers and dates start descending (biggest/newest first), text ascending. */
export function defaultDesc(key: SortKey): boolean {
  return key !== "title" && key !== "tracker" && key !== "category";
}
