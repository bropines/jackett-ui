/**
 * Jackett API client.
 *
 * Auth model: Jackett's UI endpoints use a session cookie ("Jackett"). With the
 * `X-Requested-With` header Jackett answers 401 instead of redirecting to /UI/Login.
 * On 401 we log in with POST /UI/Dashboard (form field `password`); when no admin
 * password is set an empty password works, so the UI is "just there" behind an
 * external auth layer (SSO). If a password is set, `needsPassword` is raised and
 * the app shows the login page.
 *
 * Search/download endpoints use the API key instead (`apikey=`), see `searchUrl`.
 */
import type {
  CacheEntry,
  ConfigField,
  IndexerSummary,
  JackettErrorBody,
  LogEntry,
  SearchParams,
  SearchResponse,
  ServerConfig,
  ServerConfigUpdate,
} from "@/api/types";
import { SERVER_CONFIG_READONLY } from "@/api/types";

export * from "@/api/types";

const BASE = "/api/v2.0";

export class ApiError extends Error {
  status: number;
  body?: JackettErrorBody;
  constructor(status: number, message: string, body?: JackettErrorBody) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Human-readable error text for toasts and error states. */
export function errText(err: unknown): string {
  if (err instanceof ApiError) return err.message || `HTTP ${err.status}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/* ── Session ────────────────────────────────────────────────────────────── */

type Listener = (needsPassword: boolean) => void;
const listeners = new Set<Listener>();
let needsPassword = false;

export function onNeedsPassword(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function getNeedsPassword() {
  return needsPassword;
}
function setNeedsPassword(v: boolean) {
  if (needsPassword === v) return;
  needsPassword = v;
  listeners.forEach((l) => l(v));
}

/**
 * Logs in to Jackett. Returns true when the session cookie works afterwards.
 * Jackett answers 302 either way, so success is checked with a probe request.
 */
export async function login(password = ""): Promise<boolean> {
  await fetch("/UI/Dashboard", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }),
    redirect: "manual",
    credentials: "same-origin",
  });
  const probe = await rawFetch(`${BASE}/server/config`);
  const ok = probe.ok;
  setNeedsPassword(!ok);
  return ok;
}

export async function logout(): Promise<void> {
  await fetch("/UI/Logout", { redirect: "manual", credentials: "same-origin" });
  setNeedsPassword(true);
}

/* ── Transport ──────────────────────────────────────────────────────────── */

function rawFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Requested-With", "XMLHttpRequest");
  headers.set("Accept", "application/json");
  return fetch(url, { ...init, headers, credentials: "same-origin", redirect: "manual" });
}

/**
 * An external auth proxy (oauth2-proxy & co) answers an expired session with a
 * redirect to the IdP. fetch() can't follow that cross-origin, so reload the page
 * and let the browser do the login round-trip.
 */
function isAuthProxyRedirect(res: Response): boolean {
  return res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
}

let loginInFlight: Promise<boolean> | null = null;

async function request<T>(url: string, init: RequestInit = {}, parse: "json" | "text" | "none" = "json"): Promise<T> {
  let res = await rawFetch(url, init);
  if (res.status === 401) {
    loginInFlight ??= login("").finally(() => (loginInFlight = null));
    if (await loginInFlight) res = await rawFetch(url, init);
  }
  if (isAuthProxyRedirect(res)) {
    window.location.reload();
    throw new ApiError(401, "Сессия истекла, перезагружаю страницу…");
  }
  if (res.status === 401) throw new ApiError(401, "Нужен пароль Jackett");
  if (!res.ok) {
    let body: JackettErrorBody | undefined;
    const text = await res.text().catch(() => "");
    try {
      body = JSON.parse(text) as JackettErrorBody;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, body?.error ?? (text.slice(0, 300) || `HTTP ${res.status}`), body);
  }
  if (parse === "none" || res.status === 204) return undefined as T;
  if (parse === "text") return (await res.text()) as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/* ── API key (needed for search / download / Torznab links) ─────────────── */

let apiKey = "";
export function setApiKey(key: string) {
  apiKey = key;
}
export function getApiKey() {
  return apiKey;
}

/* ── Endpoints ──────────────────────────────────────────────────────────── */

export const api = {
  /** All known indexers (configured and not). Large (~1.5 MB): cache it. */
  indexers: () => request<IndexerSummary[]>(`${BASE}/indexers`),

  indexerConfig: (id: string) => request<ConfigField[]>(`${BASE}/indexers/${encodeURIComponent(id)}/config`),

  /** Saves (and thereby adds) an indexer. Jackett logs in to the tracker here: errors are tracker errors. */
  saveIndexerConfig: (id: string, fields: ConfigField[]) =>
    request<void>(`${BASE}/indexers/${encodeURIComponent(id)}/config`, json("POST", fields), "none"),

  deleteIndexer: (id: string) => request<void>(`${BASE}/indexers/${encodeURIComponent(id)}`, { method: "DELETE" }, "none"),

  /** Runs a test query. 204 = OK; 500 with { error } on failure. */
  testIndexer: (id: string) => request<void>(`${BASE}/indexers/${encodeURIComponent(id)}/test`, { method: "POST" }, "none"),

  serverConfig: async () => {
    const cfg = await request<ServerConfig>(`${BASE}/server/config`);
    if (cfg?.api_key) setApiKey(cfg.api_key);
    return cfg;
  },

  /** Note: changing proxy settings makes Jackett restart itself (a few seconds of 502/connection errors). */
  saveServerConfig: (cfg: ServerConfig | ServerConfigUpdate) => {
    const body: Record<string, unknown> = { ...cfg };
    for (const k of SERVER_CONFIG_READONLY) delete body[k];
    return request<void>(`${BASE}/server/config`, json("POST", body), "none");
  },

  /** Sets the admin password ("" removes it). */
  setAdminPassword: (password: string) => request<void>(`${BASE}/server/adminpassword`, json("POST", password), "none"),

  logs: () => request<LogEntry[]>(`${BASE}/server/logs`),

  cache: () => request<CacheEntry[]>(`${BASE}/indexers/cache`),

  /** Search across `indexer` ("all", an id, or "tag:<name>"). */
  search: (p: SearchParams, indexer = "all", signal?: AbortSignal) =>
    request<SearchResponse>(searchUrl(p, indexer), { signal }),
};

/** Builds the JSON search URL (same as Jackett's own UI). */
export function searchUrl(p: SearchParams, indexer = "all"): string {
  const q = new URLSearchParams({ apikey: apiKey, Query: p.query });
  p.trackers?.forEach((t) => q.append("Tracker[]", t));
  p.categories?.forEach((c) => q.append("Category[]", String(c)));
  q.append("_", String(Date.now()));
  return `${BASE}/indexers/${encodeURIComponent(indexer)}/results?${q}`;
}

/** Torznab feed URL for *arr apps / qBittorrent: absolute, with trailing slash, without the key. */
export function torznabUrl(indexerId: string, origin = window.location.origin): string {
  return `${origin}${BASE}/indexers/${encodeURIComponent(indexerId)}/results/torznab/`;
}

/** CouchPotato-style feed URL (legacy). */
export function potatoUrl(indexerId: string, origin = window.location.origin): string {
  return `${origin}${BASE}/indexers/${encodeURIComponent(indexerId)}/results/potato/`;
}

/**
 * Jackett builds result links from the Host it saw. Behind a proxy that may be
 * http://127.0.0.1:9117/...; rewrite such links to the current origin so they work
 * in the browser. Links to other hosts (trackers) are left alone.
 */
export function localizeLink(link: string | null | undefined): string | null {
  if (!link) return null;
  try {
    const u = new URL(link, window.location.origin);
    if (u.pathname.startsWith("/dl/") || u.pathname.startsWith("/bh/") || u.pathname.startsWith(BASE)) {
      return `${window.location.origin}${u.pathname}${u.search}`;
    }
    return u.toString();
  } catch {
    return link;
  }
}

/* ── Query keys ─────────────────────────────────────────────────────────── */

export const qk = {
  indexers: ["indexers"] as const,
  indexerConfig: (id: string) => ["indexer-config", id] as const,
  serverConfig: ["server-config"] as const,
  logs: ["logs"] as const,
  cache: ["cache"] as const,
};
