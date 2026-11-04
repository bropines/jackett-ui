/**
 * Jackett API client.
 *
 * All Jackett calls go through the jackett-ui server, which logs in to Jackett itself
 * (server-side cookie, JACKETT_PASSWORD) and puts its own authentication in front.
 * The browser only holds our session cookie: a 401 or `{error:"setup_required"}` from any
 * call means that session is gone, so the auth gate is told to re-check
 * /_ui/api/auth/state (see `onAuthRecheck`).
 *
 * Search and downloads use the session too: the server injects Jackett's API key, which never
 * reaches the browser (download links come back with `jackett_apikey=session`).
 */
import { ApiError, errorFromResponse, isAuthProxyRedirect, maybeRecheck } from "@/api/http";
import type {
  CacheEntry,
  ConfigField,
  IndexerSummary,
  LogEntry,
  SearchParams,
  SearchResponse,
  ServerConfig,
  ServerConfigUpdate,
} from "@/api/types";
import { SERVER_CONFIG_READONLY } from "@/api/types";

export * from "@/api/types";
export { ApiError, emitAuthRecheck, errText, isForbidden, onAuthRecheck, type ServerErrorBody } from "@/api/http";
export * from "@/api/server";

const BASE = "/api/v2.0";

/* ── Transport ──────────────────────────────────────────────────────────── */

function rawFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Requested-With", "XMLHttpRequest");
  headers.set("Accept", "application/json");
  return fetch(url, { ...init, headers, credentials: "same-origin", redirect: "manual" });
}

async function request<T>(url: string, init: RequestInit = {}, parse: "json" | "text" | "none" = "json"): Promise<T> {
  const res = await rawFetch(url, init);
  if (isAuthProxyRedirect(res)) {
    window.location.reload();
    throw new ApiError(401, "Сессия истекла, перезагружаю страницу…");
  }
  if (!res.ok) {
    const err = await errorFromResponse(res);
    if (res.status === 401 && !err.code) err.message = "Сессия истекла, войдите снова";
    maybeRecheck(err);
    throw err;
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

/* ── Endpoints ──────────────────────────────────────────────────────────── */

export const api = {
  /** All known indexers (configured and not). Large (~1.5 MB, ~400 KB gzipped): load only for the catalog. */
  indexers: () => request<IndexerSummary[]>(`${BASE}/indexers`),

  /** Configured indexers only (a few hundred bytes). Use this everywhere except the "add tracker" catalog. */
  configuredIndexers: () => request<IndexerSummary[]>(`${BASE}/indexers?configured=true`),

  indexerConfig: (id: string) => request<ConfigField[]>(`${BASE}/indexers/${encodeURIComponent(id)}/config`),

  /** Saves (and thereby adds) an indexer. Jackett logs in to the tracker here: errors are tracker errors. */
  saveIndexerConfig: (id: string, fields: ConfigField[]) =>
    request<void>(`${BASE}/indexers/${encodeURIComponent(id)}/config`, json("POST", fields), "none"),

  deleteIndexer: (id: string) => request<void>(`${BASE}/indexers/${encodeURIComponent(id)}`, { method: "DELETE" }, "none"),

  /** Runs a test query. 204 = OK; 500 with { error } on failure. */
  testIndexer: (id: string) => request<void>(`${BASE}/indexers/${encodeURIComponent(id)}/test`, { method: "POST" }, "none"),

  /** Admin only. `api_key` comes back as "(hidden)": the UI never needs it. */
  serverConfig: () => request<ServerConfig>(`${BASE}/server/config`),

  /** Note: changing proxy settings makes Jackett restart itself (a few seconds of 502/connection errors). */
  saveServerConfig: (cfg: ServerConfig | ServerConfigUpdate) => {
    const body: Record<string, unknown> = { ...cfg };
    for (const k of SERVER_CONFIG_READONLY) delete body[k];
    // The server hides Jackett's key ("(hidden)"); never send it back.
    delete body.api_key;
    return request<void>(`${BASE}/server/config`, json("POST", body), "none");
  },


  logs: () => request<LogEntry[]>(`${BASE}/server/logs`),

  cache: () => request<CacheEntry[]>(`${BASE}/indexers/cache`),

  /** Search across `indexer` ("all", an id, or "tag:<name>"). */
  search: (p: SearchParams, indexer = "all", signal?: AbortSignal) =>
    request<SearchResponse>(searchUrl(p, indexer), { signal }),
};

/** Builds the JSON search URL (same as Jackett's own UI, but without `apikey`: the session authorizes it). */
export function searchUrl(p: SearchParams, indexer = "all"): string {
  const q = new URLSearchParams({ Query: p.query });
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
  /** Prefix: invalidate this after add/edit/delete, it covers both lists below. */
  indexers: ["indexers"] as const,
  indexersAll: ["indexers", "all"] as const,
  indexersConfigured: ["indexers", "configured"] as const,
  indexerConfig: (id: string) => ["indexer-config", id] as const,
  serverConfig: ["server-config"] as const,
  logs: ["logs"] as const,
  cache: ["cache"] as const,
  /** jackett-ui server: GET /_ui/api/auth/state */
  authState: ["auth-state"] as const,
  /** jackett-ui server: GET /_ui/api/settings */
  uiSettings: ["ui-settings"] as const,
  /** GET /_ui/api/me (profile, own tokens). */
  me: ["me"] as const,
  /** GET /_ui/api/users (admin). */
  users: ["users"] as const,
  userTokens: (id: string) => ["users", id, "tokens"] as const,
  /** GET /_ui/api/invites (admin). */
  invites: ["invites"] as const,
  /** GET /_ui/api/invites/{token} (public). */
  publicInvite: (token: string) => ["public-invite", token] as const,
};
