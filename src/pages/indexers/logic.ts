/** Pure helpers for the Indexers page and the "add tracker" catalog (unit-tested). */
import type { IndexerSummary, IndexerType } from "@/api";

/* ── Types & labels ─────────────────────────────────────────────────────── */

export const TYPE_LABELS: Record<IndexerType, string> = {
  public: "Публичный",
  "semi-private": "Полуприватный",
  private: "Приватный",
};

/** Catalog categories, mapped to Torznab thousand ranges. */
export type CategoryKey = "movies" | "tv" | "audio" | "books" | "games" | "xxx" | "other";

export const CATEGORIES: { key: CategoryKey; label: string; ranges: number[] }[] = [
  { key: "movies", label: "Фильмы", ranges: [2000] },
  { key: "tv", label: "Сериалы", ranges: [5000] },
  { key: "audio", label: "Музыка", ranges: [3000] },
  { key: "books", label: "Книги", ranges: [7000] },
  { key: "games", label: "Игры и софт", ranges: [1000, 4000] },
  { key: "xxx", label: "XXX", ranges: [6000] },
  { key: "other", label: "Другое", ranges: [8000] },
];

/** Thousand range of a Torznab category id (2040 → 2000). Tracker-specific ids (≥ 100000) → null. */
export function capRange(id: string | number): number | null {
  const n = typeof id === "number" ? id : Number.parseInt(id, 10);
  if (!Number.isFinite(n) || n < 1000 || n >= 100000) return null;
  return Math.floor(n / 1000) * 1000;
}

/** True if any of the indexer's caps falls into the category's ranges. */
export function matchesCategory(ix: Pick<IndexerSummary, "caps">, cat: CategoryKey): boolean {
  const def = CATEGORIES.find((c) => c.key === cat);
  if (!def) return false;
  return (ix.caps ?? []).some((c) => {
    const r = capRange(c.ID);
    return r !== null && def.ranges.includes(r);
  });
}

/** Category keys an indexer covers, in CATEGORIES order. */
export function indexerCategories(ix: Pick<IndexerSummary, "caps">): CategoryKey[] {
  return CATEGORIES.filter((c) => matchesCategory(ix, c.key)).map((c) => c.key);
}

/* ── Languages ──────────────────────────────────────────────────────────── */

export const PREFERRED_LANGUAGES = ["ru-RU", "en-US"];

let displayNames: Intl.DisplayNames | null | undefined;

/** "ru-RU" → "Русский (Россия)"; falls back to the code. */
export function languageName(code: string): string {
  if (!code) return "—";
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(["ru"], { type: "language" });
    } catch {
      displayNames = null;
    }
  }
  try {
    const name = displayNames?.of(code);
    if (name && name !== code) return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    /* invalid tag */
  }
  return code;
}

export interface LanguageOption {
  code: string;
  label: string;
  count: number;
}

/** Distinct languages with counts: ru-RU and en-US first, the rest by label. */
export function languageOptions(list: Pick<IndexerSummary, "language">[]): LanguageOption[] {
  const counts = new Map<string, number>();
  for (const ix of list) {
    const code = ix.language || "";
    if (!code) continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const opts = [...counts].map(([code, count]) => ({ code, count, label: languageName(code) }));
  const rank = (code: string) => {
    const i = PREFERRED_LANGUAGES.indexOf(code);
    return i === -1 ? PREFERRED_LANGUAGES.length : i;
  };
  return opts.sort((a, b) => rank(a.code) - rank(b.code) || a.label.localeCompare(b.label, "ru") || a.code.localeCompare(b.code));
}

/** Short language tag for badges: "ru-RU" → "RU", "en-US" → "EN". */
export function languageShort(code: string): string {
  return (code.split("-")[0] ?? code).toUpperCase();
}

/* ── Catalog filtering ──────────────────────────────────────────────────── */

export interface CatalogFilter {
  query: string;
  type: IndexerType | "all";
  language: string | "all";
  category: CategoryKey | "all";
}

export const EMPTY_FILTER: CatalogFilter = { query: "", type: "all", language: "all", category: "all" };

export function normalize(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").trim();
}

/**
 * Relevance of `ix` for a query (lower = better), or null when it does not match.
 * Every word must occur in name, id or description.
 */
export function matchScore(ix: Pick<IndexerSummary, "id" | "name" | "description">, query: string): number | null {
  const q = normalize(query);
  if (!q) return 0;
  const name = normalize(ix.name);
  const id = ix.id.toLowerCase();
  const desc = normalize(ix.description ?? "");
  const words = q.split(/\s+/);
  for (const w of words) {
    if (!name.includes(w) && !id.includes(w) && !desc.includes(w)) return null;
  }
  if (name === q || id === q) return 0;
  if (name.startsWith(q) || id.startsWith(q)) return 1;
  if (name.includes(q) || id.includes(q)) return 2;
  if (words.every((w) => name.includes(w) || id.includes(w))) return 3;
  return 4;
}

/** Filters and sorts indexers for the catalog (by relevance when searching, else by name). */
export function filterCatalog<T extends IndexerSummary>(list: T[], f: CatalogFilter): T[] {
  const scored: { ix: T; score: number }[] = [];
  for (const ix of list) {
    if (f.type !== "all" && ix.type !== f.type) continue;
    if (f.language !== "all" && ix.language !== f.language) continue;
    if (f.category !== "all" && !matchesCategory(ix, f.category)) continue;
    const score = matchScore(ix, f.query);
    if (score === null) continue;
    scored.push({ ix, score });
  }
  scored.sort((a, b) => a.score - b.score || a.ix.name.localeCompare(b.ix.name, "ru", { sensitivity: "base" }));
  return scored.map((s) => s.ix);
}

export function isFilterActive(f: CatalogFilter): boolean {
  return f.query.trim() !== "" || f.type !== "all" || f.language !== "all" || f.category !== "all";
}

/** Filter for the configured list: name / id / description / tags. */
export function filterConfigured<T extends IndexerSummary>(list: T[], query: string): T[] {
  const q = normalize(query);
  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name, "ru", { sensitivity: "base" }));
  if (!q) return sorted;
  return sorted.filter((ix) => matchScore(ix, q) !== null || ix.tags.some((t) => normalize(t).includes(q)));
}

/* ── Misc ───────────────────────────────────────────────────────────────── */

/** First non-empty line of an error, trimmed of Jackett's quoting noise. */
export function firstLine(text: string, max = 300): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** "https://rutracker.org/forum/" → "rutracker.org". */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/* ── Test results ───────────────────────────────────────────────────────── */

export type TestState =
  | { status: "running" }
  | { status: "ok"; at: number }
  | { status: "error"; error: string; at: number };

/** Effective status of a configured indexer: the latest local test wins over Jackett's last_error. */
export function effectiveStatus(
  ix: Pick<IndexerSummary, "last_error">,
  test: TestState | undefined,
): { kind: "running" } | { kind: "ok"; tested: boolean } | { kind: "error"; error: string; tested: boolean } {
  if (test?.status === "running") return { kind: "running" };
  if (test?.status === "ok") return { kind: "ok", tested: true };
  if (test?.status === "error") return { kind: "error", error: test.error, tested: true };
  if (ix.last_error) return { kind: "error", error: ix.last_error, tested: false };
  return { kind: "ok", tested: false };
}

/* ── Concurrency-limited queue ──────────────────────────────────────────── */

export interface QueueOptions {
  concurrency: number;
  /** Called after each item settles, with the number done so far. */
  onProgress?: (done: number, total: number) => void;
  /** Checked before starting each item; true stops picking new items. */
  shouldStop?: () => boolean;
}

export type QueueResult<T> = { item: T; ok: true } | { item: T; ok: false; error: unknown };

/** Runs `worker` over `items` with at most `concurrency` in flight. Never rejects. */
export async function runQueue<T>(items: T[], worker: (item: T) => Promise<unknown>, opts: QueueOptions): Promise<QueueResult<T>[]> {
  const results: QueueResult<T>[] = [];
  let next = 0;
  let done = 0;
  const total = items.length;
  const lane = async () => {
    while (next < total) {
      if (opts.shouldStop?.()) return;
      const item = items[next++] as T;
      try {
        await worker(item);
        results.push({ item, ok: true });
      } catch (error) {
        results.push({ item, ok: false, error });
      }
      done++;
      opts.onProgress?.(done, total);
    }
  };
  const lanes = Math.max(1, Math.min(opts.concurrency, total));
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}
