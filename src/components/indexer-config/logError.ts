import type { LogEntry } from "@/api";

/** Generic texts that tell nothing about the cause: worth looking into the Jackett log. */
export function isVagueError(message: string): boolean {
  const m = message.trim();
  return m === "" || /^(HTTP )?5\d\d\b/i.test(m) || /^internal server error$/i.test(m) || /^внутренняя ошибка/i.test(m);
}

/**
 * The first line of a Jackett log message without the exception type prefix:
 * "FlareSolverrSharp.Exceptions.FlareSolverrException: Challenge detected…" → "Challenge detected…".
 */
export function logHeadline(message: string): string {
  const first = message.split("\n")[0]?.trim() ?? "";
  return first.replace(/^(?:[A-Za-z_][\w`]*\.)*\w*Exception:\s*/, "").trim() || first;
}

/**
 * Finds the error Jackett logged for a failed save of `indexerId` at or after `since`
 * (ms epoch; a few seconds of clock slack are allowed). Prefers entries that name the
 * tracker; falls back to the only error in that window.
 */
export function saveErrorFromLogs(logs: LogEntry[], indexerId: string, since: number): string | null {
  const from = since - 5_000;
  const errors = logs.filter((l) => /^(error|fatal)$/i.test(l.Level) && Date.parse(l.When) >= from);
  if (errors.length === 0) return null;
  const id = indexerId.toLowerCase().replace(/[^a-z0-9]/g, "");
  const named = errors.filter((l) => l.Message.toLowerCase().replace(/[^a-z0-9]/g, "").includes(id));
  const pick = named.length > 0 ? named : errors.length === 1 ? errors : [];
  if (pick.length === 0) return null;
  const latest = pick.reduce((a, b) => (Date.parse(b.When) >= Date.parse(a.When) ? b : a));
  return logHeadline(latest.Message);
}
