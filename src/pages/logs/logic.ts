/** Pure helpers for the logs page: level normalisation, ordering, filtering. */
import type { LogEntry } from "@/api/types";

export type LogLevel = "error" | "warn" | "info" | "debug";
export type LevelFilter = "all" | LogLevel;

export const LEVELS: { value: LevelFilter; label: string }[] = [
  { value: "all", label: "Все" },
  { value: "error", label: "Ошибки" },
  { value: "warn", label: "Предупр." },
  { value: "info", label: "Инфо" },
  { value: "debug", label: "Отладка" },
];

export function normalizeLevel(level: string | null | undefined): LogLevel {
  switch ((level ?? "").toLowerCase()) {
    case "error":
    case "fatal":
      return "error";
    case "warn":
    case "warning":
      return "warn";
    case "debug":
    case "trace":
      return "debug";
    default:
      return "info";
  }
}

export interface LogRow {
  /** Position in the API response (tie-breaker for equal timestamps). */
  key: number;
  /** React key that survives refreshes (new entries shift positions). */
  id: string;
  level: LogLevel;
  when: string;
  time: number;
  message: string;
  firstLine: string;
  multiline: boolean;
}

/** First non-empty line of a message (stack traces put the summary there). */
export function firstLine(message: string): string {
  const lines = message.split(/\r?\n/);
  return (lines.find((l) => l.trim() !== "") ?? "").trim();
}

export function isMultiline(message: string): boolean {
  return message.trim().split(/\r?\n/).length > 1;
}

/** Newest first. Entries with the same timestamp keep the API order. */
export function toRows(entries: LogEntry[]): LogRow[] {
  const rows = entries
    .map((e, i) => {
      const t = Date.parse(e.When);
      const message = e.Message ?? "";
      return {
        key: i,
        id: "",
        level: normalizeLevel(e.Level),
        when: e.When,
        time: Number.isNaN(t) ? 0 : t,
        message,
        firstLine: firstLine(message),
        multiline: isMultiline(message),
      };
    })
    .sort((a, b) => b.time - a.time || a.key - b.key);
  // Count duplicates from the oldest end so ids don't change when new entries arrive on top.
  const seen = new Map<string, number>();
  for (const r of [...rows].reverse()) {
    const base = `${r.when}|${r.level}|${r.firstLine}`;
    const nth = seen.get(base) ?? 0;
    seen.set(base, nth + 1);
    r.id = `${base}#${nth}`;
  }
  return rows;
}

export function countByLevel(rows: LogRow[]): Record<LevelFilter, number> {
  const c: Record<LevelFilter, number> = { all: rows.length, error: 0, warn: 0, info: 0, debug: 0 };
  for (const r of rows) c[r.level]++;
  return c;
}

export function filterRows(rows: LogRow[], level: LevelFilter, query: string): LogRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => (level === "all" || r.level === level) && (!q || r.message.toLowerCase().includes(q)));
}
