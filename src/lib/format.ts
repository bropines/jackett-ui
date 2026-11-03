/** Russian formatting helpers. Inputs are RFC 3339 strings from the API; Go zero times count as empty. */

const LANG = "ru-RU";

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 2000) return null;
  return d;
}

export function isSet(iso: string | null | undefined): boolean {
  return parse(iso) !== null;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/** "3 минуты назад" / "через 2 часа"; "сейчас" under 10 s. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  const d = parse(iso);
  if (!d) return "—";
  const diff = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(LANG, { numeric: "auto" });
  if (abs < 10) return rtf.format(0, "second");
  for (const [unit, secs] of UNITS) {
    if (abs >= secs || unit === "second") return rtf.format(Math.trunc(diff / secs), unit);
  }
  return rtf.format(diff, "second");
}

export function formatDateTime(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return "—";
  return new Intl.DateTimeFormat(LANG, { dateStyle: "medium", timeStyle: "short" }).format(d);
}

/** Hint for 24 h numbers: «данные за 24 ч» or «неполные данные с <time> (N ч)». */
export function statsCoverage(s: { complete: boolean; coverage_from: string | null; window_seconds: number }): string {
  if (s.complete) return "данные за 24 ч";
  if (!s.coverage_from) return "журнал AdGuard ещё не прочитан";
  const h = Math.floor(s.window_seconds / 3600);
  const span = h >= 1 ? `${h} ч` : `${Math.max(0, Math.floor(s.window_seconds / 60))} мин`;
  return `неполные данные с ${formatDateTime(s.coverage_from)} (за ${span}, журнал дочитывается)`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat(LANG).format(n);
}

/** Russian plural: plural(5, ["домен", "домена", "доменов"]) → "доменов". */
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

const stepNames: Record<string, string> = {
  adguard_clients: "Клиенты AdGuard",
  adguard_rules: "Правила AdGuard",
  sni_map: "SNI-карта Angie",
};

export function stepName(n: string): string {
  return stepNames[n] ?? n;
}

const reasons: Record<string, string> = {
  startup: "запуск",
  periodic: "по расписанию",
  manual: "вручную",
  change: "изменение",
};

export function syncReason(r: string | undefined): string {
  if (!r) return "—";
  return reasons[r] ?? r;
}

/** Splits a textarea of domains (newline / space / comma / semicolon separated). */
export function parseDomains(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
