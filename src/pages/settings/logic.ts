/**
 * Pure helpers for the settings page: server config ↔ editable form, validation,
 * dirty and proxy-change detection.
 */
import type { ProxyType, ServerConfig } from "@/api/types";

/** Editable part of the server config. Numbers are kept as strings while typing; nullable strings as "". */
export interface SettingsForm {
  proxy_type: ProxyType;
  proxy_url: string;
  proxy_port: string;
  proxy_username: string;
  proxy_password: string;
  flaresolverrurl: string;
  flaresolverr_maxtimeout: string;
  cache_enabled: boolean;
  cache_ttl: string;
  cache_max_results_per_indexer: string;
  blackholedir: string;
  baseurloverride: string;
  basepathoverride: string;
  cors: boolean;
  logging: boolean;
  omdbkey: string;
  omdburl: string;
  updatedisabled: boolean;
  prerelease: boolean;
}

export type FormErrors = Partial<Record<keyof SettingsForm, string>>;

export const PROXY_TYPES: { value: ProxyType; label: string }[] = [
  { value: -1, label: "Выключен" },
  { value: 0, label: "HTTP" },
  { value: 1, label: "SOCKS4" },
  { value: 2, label: "SOCKS5" },
];

const s = (v: string | null | undefined) => v ?? "";
const n = (v: number | null | undefined) => (v == null ? "" : String(v));

export function toForm(cfg: ServerConfig): SettingsForm {
  return {
    proxy_type: cfg.proxy_type,
    proxy_url: s(cfg.proxy_url),
    proxy_port: n(cfg.proxy_port),
    proxy_username: s(cfg.proxy_username),
    proxy_password: s(cfg.proxy_password),
    flaresolverrurl: s(cfg.flaresolverrurl),
    flaresolverr_maxtimeout: n(cfg.flaresolverr_maxtimeout),
    cache_enabled: cfg.cache_enabled,
    cache_ttl: n(cfg.cache_ttl),
    cache_max_results_per_indexer: n(cfg.cache_max_results_per_indexer),
    blackholedir: s(cfg.blackholedir),
    baseurloverride: s(cfg.baseurloverride),
    basepathoverride: s(cfg.basepathoverride),
    cors: cfg.cors,
    logging: cfg.logging,
    omdbkey: s(cfg.omdbkey),
    omdburl: s(cfg.omdburl),
    updatedisabled: cfg.updatedisabled,
    prerelease: cfg.prerelease,
  };
}

const orNull = (v: string) => (v.trim() === "" ? null : v.trim());
const int = (v: string, fallback: number) => {
  const x = Number(v.trim());
  return v.trim() !== "" && Number.isFinite(x) ? Math.trunc(x) : fallback;
};

/** Applies the form on top of the loaded config. The result is the whole object to POST back. */
export function fromForm(form: SettingsForm, base: ServerConfig): ServerConfig {
  return {
    ...base,
    proxy_type: form.proxy_type,
    proxy_url: orNull(form.proxy_url),
    proxy_port: form.proxy_port.trim() === "" ? null : int(form.proxy_port, base.proxy_port ?? 0),
    proxy_username: orNull(form.proxy_username),
    // Passwords are not trimmed: spaces may be meaningful.
    proxy_password: form.proxy_password === "" ? null : form.proxy_password,
    flaresolverrurl: orNull(form.flaresolverrurl),
    flaresolverr_maxtimeout: int(form.flaresolverr_maxtimeout, base.flaresolverr_maxtimeout),
    cache_enabled: form.cache_enabled,
    cache_ttl: int(form.cache_ttl, base.cache_ttl),
    cache_max_results_per_indexer: int(form.cache_max_results_per_indexer, base.cache_max_results_per_indexer),
    blackholedir: orNull(form.blackholedir),
    baseurloverride: orNull(form.baseurloverride),
    basepathoverride: orNull(form.basepathoverride),
    cors: form.cors,
    logging: form.logging,
    omdbkey: orNull(form.omdbkey),
    omdburl: orNull(form.omdburl),
    updatedisabled: form.updatedisabled,
    prerelease: form.prerelease,
  };
}

export function isHttpUrl(v: string): boolean {
  return /^https?:\/\/[^\s/]+/i.test(v.trim());
}

function nonNegInt(v: string): string | undefined {
  const t = v.trim();
  if (t === "") return "Укажите число";
  if (!/^\d+$/.test(t)) return "Целое число ≥ 0";
  return undefined;
}

export function validate(form: SettingsForm): FormErrors {
  const e: FormErrors = {};
  if (form.proxy_type !== -1) {
    if (form.proxy_url.trim() === "") e.proxy_url = "Укажите адрес прокси";
    else if (/\s/.test(form.proxy_url.trim())) e.proxy_url = "Адрес без пробелов";
    const p = form.proxy_port.trim();
    if (p === "") e.proxy_port = "Укажите порт";
    else if (!/^\d+$/.test(p) || Number(p) < 1 || Number(p) > 65535) e.proxy_port = "Порт от 1 до 65535";
  }
  if (form.flaresolverrurl.trim() && !isHttpUrl(form.flaresolverrurl)) e.flaresolverrurl = "Адрес вида http://host:8191";
  const ft = nonNegInt(form.flaresolverr_maxtimeout);
  if (ft) e.flaresolverr_maxtimeout = ft;
  const ttl = nonNegInt(form.cache_ttl);
  if (ttl) e.cache_ttl = ttl;
  const max = nonNegInt(form.cache_max_results_per_indexer);
  if (max) e.cache_max_results_per_indexer = max;
  if (form.baseurloverride.trim() && !isHttpUrl(form.baseurloverride)) e.baseurloverride = "Адрес вида https://jackett.example.com";
  if (form.basepathoverride.trim() && !form.basepathoverride.trim().startsWith("/")) e.basepathoverride = "Путь начинается с /";
  if (form.omdburl.trim() && !isHttpUrl(form.omdburl)) e.omdburl = "Адрес вида https://www.omdbapi.com";
  return e;
}

export function hasErrors(e: FormErrors): boolean {
  return Object.values(e).some(Boolean);
}

/** True when the form differs from the loaded config. */
export function isDirty(form: SettingsForm, cfg: ServerConfig): boolean {
  const a = toForm(cfg);
  return (Object.keys(a) as (keyof SettingsForm)[]).some((k) => a[k] !== form[k]);
}

const PROXY_KEYS = ["proxy_type", "proxy_url", "proxy_port", "proxy_username", "proxy_password"] as const;

/** Saving a config with different proxy settings makes Jackett restart. */
export function proxyChanged(before: ServerConfig, after: ServerConfig): boolean {
  return PROXY_KEYS.some((k) => (before[k] ?? null) !== (after[k] ?? null));
}

/** 2100 → "35 мин", 3660 → "1 ч 1 мин", 90000 → "1 д 1 ч". */
export function humanSeconds(total: number): string {
  if (!Number.isFinite(total) || total < 0) return "—";
  if (total === 0) return "0 с";
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = Math.floor(total % 60);
  const parts: string[] = [];
  if (d) parts.push(`${d} д`);
  if (h) parts.push(`${h} ч`);
  if (m) parts.push(`${m} мин`);
  if (sec && !d) parts.push(`${sec} с`);
  return parts.slice(0, 2).join(" ");
}

export function maskSecret(v: string): string {
  return "•".repeat(Math.min(Math.max(v.length, 8), 32));
}
