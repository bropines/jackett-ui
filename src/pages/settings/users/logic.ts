import type { Role, UserEntry } from "@/api";

export const INVITE_DEFAULT_DAYS = 7;
export const INVITE_MAX_DAYS = 30;

/** Admins first, then editors, viewers; disabled users last; then by name. */
export function sortUsers(users: UserEntry[]): UserEntry[] {
  const rank: Record<Role, number> = { admin: 0, editor: 1, viewer: 2 };
  return [...users].sort(
    (a, b) =>
      Number(a.disabled) - Number(b.disabled) ||
      (rank[a.role] ?? 3) - (rank[b.role] ?? 3) ||
      (a.name || a.username).localeCompare(b.name || b.username, "ru"),
  );
}

/** Validates the invite expiry: whole days, 1…30. */
export function inviteDaysError(v: string): string | undefined {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > INVITE_MAX_DAYS) return `От 1 до ${INVITE_MAX_DAYS} дней`;
  return undefined;
}

/** Makes an invite URL absolute (the server may return a path when PUBLIC_URL is not set). */
export function absoluteUrl(url: string, origin = window.location.origin): string {
  try {
    return new URL(url, origin).toString();
  } catch {
    return url;
  }
}
