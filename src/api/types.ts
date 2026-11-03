/**
 * Types for the stock Jackett API (v2.0), taken from live responses of Jackett v0.24.x.
 * Samples live in /contract. Field names are Jackett's own (snake_case for server config,
 * PascalCase for search results), do not rename them here.
 */

export type IndexerType = "public" | "private" | "semi-private";

/** GET /api/v2.0/indexers — every known indexer (≈650), configured or not. */
export interface IndexerSummary {
  id: string;
  name: string;
  description: string;
  type: IndexerType;
  configured: boolean;
  site_link: string;
  alternativesitelinks: string[];
  /** BCP 47-ish, e.g. "ru-RU", "en-US". */
  language: string;
  tags: string[];
  /** Empty string when the last query succeeded. */
  last_error: string;
  potatoenabled: boolean;
  /** Torznab categories. IDs ≥ 100000 are tracker-specific. */
  caps: { ID: string; Name: string }[];
}

/* ── Indexer configuration form ─────────────────────────────────────────── */

interface FieldBase {
  /** Can be "" for spacer/info rows. Must be sent back unchanged. */
  id: string;
  name: string;
}

export interface InputStringField extends FieldBase {
  type: "inputstring";
  value: string | null;
}
export interface PasswordField extends FieldBase {
  type: "password";
  value: string | null;
}
export interface HiddenDataField extends FieldBase {
  type: "hiddendata";
  value: string | null;
}
export interface InputBoolField extends FieldBase {
  type: "inputbool";
  value: boolean;
}
/** Single choice. `options` maps value → label. */
export interface InputSelectField extends FieldBase {
  type: "inputselect";
  value: string;
  options: Record<string, string>;
}
/** Multiple choice. Note `values` (array), not `value`. */
export interface InputCheckboxField extends FieldBase {
  type: "inputcheckbox";
  values: string[];
  options: Record<string, string>;
}
/** Tag list stored as one string joined by `separator`; each tag must match `pattern`. */
export interface InputTagsField extends FieldBase {
  type: "inputtags";
  value: string;
  separator: string;
  delimiters: string;
  pattern: string;
}
/** Read-only HTML help text (links, <b>, <br>). Render sanitized. */
export interface DisplayInfoField extends FieldBase {
  type: "displayinfo";
  value: string | null;
}
/** Read-only image, usually a captcha as a data: URL. `null` when there is none. */
export interface DisplayImageField extends FieldBase {
  type: "displayimage";
  value: string | null;
}
/** Legacy Google reCAPTCHA (very rare). The new UI cannot solve it. */
export interface RecaptchaField extends FieldBase {
  type: "recaptcha";
  sitekey?: string;
  version?: string;
  value?: string | null;
  cookieheader?: string;
}

export type ConfigField =
  | InputStringField
  | PasswordField
  | HiddenDataField
  | InputBoolField
  | InputSelectField
  | InputCheckboxField
  | InputTagsField
  | DisplayInfoField
  | DisplayImageField
  | RecaptchaField;

export type ConfigFieldType = ConfigField["type"];

/* ── Server config ──────────────────────────────────────────────────────── */

/** proxy_type: -1 disabled, 0 HTTP, 1 SOCKS4, 2 SOCKS5. */
export type ProxyType = -1 | 0 | 1 | 2;

/** GET/POST /api/v2.0/server/config. POST the whole object back (minus the read-only keys). */
export interface ServerConfig {
  notices: string[];
  port: number;
  external: boolean;
  local_bind_address: string;
  cors: boolean;
  api_key: string;
  blackholedir: string | null;
  updatedisabled: boolean;
  prerelease: boolean;
  /** Always "" when read back; Jackett hashes it. Change via POST /server/adminpassword. */
  password: string;
  logging: boolean;
  basepathoverride: string | null;
  baseurloverride: string | null;
  cache_enabled: boolean;
  cache_ttl: number;
  cache_max_results_per_indexer: number;
  flaresolverrurl: string | null;
  flaresolverr_maxtimeout: number;
  omdbkey: string | null;
  omdburl: string | null;
  app_version: string;
  can_run_netcore: boolean;
  proxy_type: ProxyType;
  proxy_url: string | null;
  proxy_port: number | null;
  proxy_username: string | null;
  proxy_password: string | null;
}

/** Keys Jackett returns but does not accept back. */
export const SERVER_CONFIG_READONLY = ["notices", "app_version", "can_run_netcore"] as const;
export type ServerConfigUpdate = Omit<ServerConfig, (typeof SERVER_CONFIG_READONLY)[number]>;

/* ── Search ─────────────────────────────────────────────────────────────── */

/** One release. Many fields are null for most trackers. */
export interface SearchResult {
  FirstSeen: string;
  Tracker: string;
  TrackerId: string;
  TrackerType: IndexerType;
  CategoryDesc: string | null;
  /** Present only when a blackhole dir is set. */
  BlackholeLink: string | null;
  Title: string;
  Guid: string;
  /** Jackett proxy download link (/dl/...?jackett_apikey=...). Absolute URL built from the request host. */
  Link: string | null;
  /** Tracker page of the release. */
  Details: string | null;
  PublishDate: string;
  Category: number[];
  /** Bytes. */
  Size: number | null;
  Files: number | null;
  Grabs: number | null;
  Description: string | null;
  RageID: number | null;
  TVDBId: number | null;
  Imdb: number | null;
  TMDb: number | null;
  TVMazeId: number | null;
  TraktId: number | null;
  DoubanId: number | null;
  Genres: string[] | null;
  Languages: string[];
  Subs: string[];
  Year: number | null;
  Author: string | null;
  BookTitle: string | null;
  Publisher: string | null;
  Artist: string | null;
  Album: string | null;
  Label: string | null;
  Track: string | null;
  Seeders: number | null;
  Peers: number | null;
  Poster: string | null;
  InfoHash: string | null;
  MagnetUri: string | null;
  MinimumRatio: number | null;
  MinimumSeedTime: number | null;
  DownloadVolumeFactor: number | null;
  UploadVolumeFactor: number | null;
  Gain: number | null;
}

/** Per-indexer outcome of a search. Status: 1 = error, 2 = OK. */
export interface SearchIndexerStatus {
  ID: string;
  Name: string;
  Status: number;
  Results: number;
  Error: string | null;
  /** Milliseconds. */
  ElapsedTime: number;
}

/** GET /api/v2.0/indexers/{id|all|tag:x}/results?apikey=…&Query=…&Tracker[]=…&Category[]=… */
export interface SearchResponse {
  Results: SearchResult[];
  Indexers: SearchIndexerStatus[];
}

export interface SearchParams {
  query: string;
  /** Limit to these indexer ids (empty = all configured). */
  trackers?: string[];
  /** Torznab category ids. */
  categories?: number[];
}

/* ── Misc ───────────────────────────────────────────────────────────────── */

/** GET /api/v2.0/server/logs (newest last). */
export interface LogEntry {
  Level: "Debug" | "Info" | "Warn" | "Error" | string;
  Message: string;
  When: string;
}

/** GET /api/v2.0/indexers/cache — recent results kept in Jackett's cache (same shape as SearchResult). */
export type CacheEntry = SearchResult;

/** Error body Jackett returns with HTTP 500. */
export interface JackettErrorBody {
  result: "error";
  error: string;
  stacktrace?: string;
}
