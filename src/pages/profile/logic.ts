import type { ApiToken } from "@/api";

/** Token lifetimes offered in the create dialog (days; 0 = never expires). */
export const TOKEN_EXPIRY: { days: number; label: string }[] = [
  { days: 0, label: "Никогда" },
  { days: 30, label: "30 дней" },
  { days: 90, label: "90 дней" },
  { days: 365, label: "365 дней" },
];

export const TOKEN_NAME_MAX = 64;

export function tokenNameError(name: string): string | undefined {
  const n = name.trim();
  if (!n) return "Укажите название, например «qBittorrent»";
  if (n.length > TOKEN_NAME_MAX) return `Не длиннее ${TOKEN_NAME_MAX} символов`;
  return undefined;
}

/** Body of `POST /me/tokens`: no `expiresInDays` for "never". */
export function tokenCreateBody(name: string, days: number): { name: string; expiresInDays?: number } {
  return days > 0 ? { name: name.trim(), expiresInDays: days } : { name: name.trim() };
}

export function isExpired(t: Pick<ApiToken, "expiresAt">, now = Date.now()): boolean {
  if (!t.expiresAt) return false;
  const at = Date.parse(t.expiresAt);
  return Number.isFinite(at) && at <= now;
}
