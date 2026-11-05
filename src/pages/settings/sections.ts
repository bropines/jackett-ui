/**
 * Pure helpers for the per-section settings UI: which errors belong to a section, the
 * one-method switch patch, what a login method card may do, tab parsing, session TTL text.
 */
import { METHOD_IDS, PROVIDER_IDS, type MethodId, type ProviderId, type UiSettings, type UiSettingsPatch } from "@/api/server";
import { lockedHint, P, type AuthErrors, type FieldPath } from "@/pages/settings/auth/logic";
import { humanSeconds } from "@/pages/settings/logic";

/* ── Tabs ─────────────────────────────────────────────────────────────── */

export const SETTINGS_TABS = ["login", "users", "jackett", "general"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
/** Tab values from older links that still work. */
const LEGACY_TABS: Record<string, SettingsTab> = { panel: "login" };

/** `?tab=` → a known tab (old values mapped), else undefined. */
export function parseSettingsTab(v: string | undefined): SettingsTab | undefined {
  if (!v) return undefined;
  if (LEGACY_TABS[v]) return LEGACY_TABS[v];
  return (SETTINGS_TABS as readonly string[]).includes(v) ? (v as SettingsTab) : undefined;
}

/* ── Section errors ───────────────────────────────────────────────────── */

/** True when `path` is one of `prefixes` or below one of them ("auth.header" ⊃ "auth.header.name"). */
export function inSection(path: FieldPath, prefixes: readonly FieldPath[]): boolean {
  return prefixes.some((p) => path === p || path.startsWith(`${p}.`));
}

/** Keeps only the (non-empty) errors of a section. */
export function sectionErrors(errors: AuthErrors, prefixes: readonly FieldPath[]): AuthErrors {
  return Object.fromEntries(Object.entries(errors).filter(([k, v]) => v && inSection(k, prefixes)));
}

/** Field prefixes of each settings section (what it edits and which errors it shows). */
export const SECTION_PATHS = {
  header: ["auth.header"],
  signup: [P.autoProvision, P.defaultRole, P.allowedEmails, P.adminEmails, P.githubUsers],
  general: [P.publicUrl, P.sessionTtl],
} as const satisfies Record<string, readonly FieldPath[]>;

/* ── Login methods ────────────────────────────────────────────────────── */

const isProvider = (m: MethodId): m is ProviderId => (PROVIDER_IDS as readonly string[]).includes(m);

/** `PUT /settings` body that switches one method on or off; `methods` always goes complete. */
export function methodPatch(s: UiSettings, id: MethodId, on: boolean): UiSettingsPatch {
  const methods = Object.fromEntries(METHOD_IDS.map((m) => [m, m === id ? on : !!s.auth.methods?.[m]?.value])) as Record<MethodId, boolean>;
  return { auth: { methods } };
}

export interface MethodState {
  on: boolean;
  /** Provider: client id is set. Header: name and proxy networks are set. Others: true. */
  configured: boolean;
  /** Provider: test login passed. Others: true. */
  verified: boolean;
  /** The switch can be flipped now. */
  canToggle: boolean;
  /** Why the switch is unavailable (or a warning about turning it on). */
  reason?: string;
}

export function methodState(s: UiSettings, id: MethodId): MethodState {
  const on = !!s.auth.methods?.[id]?.value;
  let configured = true;
  let verified = true;
  if (isProvider(id)) {
    const p = s.auth.providers[id];
    configured = (p.clientId.value ?? "").trim() !== "";
    verified = configured && p.verified;
  } else if (id === "header") {
    configured = (s.auth.header.name.value ?? "").trim() !== "" && (s.auth.header.trusted.value ?? []).length > 0;
  }

  const lock = lockedHint(s, P.method(id));
  if (s.auth.disabled?.value) return { on, configured, verified, canToggle: false, reason: "Вход отключён целиком (см. ниже)" };
  if (lock) return { on, configured, verified, canToggle: false, reason: lock };
  if (!on && isProvider(id) && !configured) return { on, configured, verified, canToggle: false, reason: "Сначала нажмите «Настроить»" };
  if (!on && isProvider(id) && !verified) return { on, configured, verified, canToggle: false, reason: "Сначала проверьте вход в «Настроить»" };
  if (!on && id === "header" && !configured) {
    return { on, configured, verified, canToggle: false, reason: "Сначала укажите заголовок и адреса прокси" };
  }
  return { on, configured, verified, canToggle: true };
}

/**
 * Card that shows a server error from a method switch: `auth.methods.<id>` → that card,
 * anything else (e.g. `auth.methods`, would_lock_out) → the card that was switched.
 */
export function methodErrorTarget(field: string | undefined, toggled: MethodId): MethodId {
  const m = field?.match(/^auth\.methods\.(\w+)$/)?.[1];
  return m && (METHOD_IDS as readonly string[]).includes(m) ? (m as MethodId) : toggled;
}

/* ── Session TTL ──────────────────────────────────────────────────────── */

const UNIT: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 0.001 };

/** Go duration ("168h", "1h30m") → seconds; null when it isn't one. */
export function parseDuration(v: string): number | null {
  const t = v.trim();
  if (!/^(?:\d+(?:\.\d+)?(?:h|ms|m|s))+$/.test(t)) return null;
  let total = 0;
  for (const [, n, u] of t.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s)/g)) total += Number(n) * UNIT[u!]!;
  return total;
}

/** "168h" → "7 д"; "" → undefined (server default); invalid → undefined. */
export function durationText(v: string): string | undefined {
  const sec = parseDuration(v);
  return sec === null ? undefined : humanSeconds(sec);
}
