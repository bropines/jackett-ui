/**
 * Client for the jackett-ui server's own API (`/_ui/api/*`): authentication state,
 * login/setup/logout and the server settings. See docs/server-spec.md.
 */
import { ApiError, errorFromResponse, isAuthProxyRedirect, maybeRecheck } from "@/api/http";

export type AuthMode = "password" | "sso" | "header" | "none";

export const AUTH_MODES: readonly AuthMode[] = ["password", "sso", "header", "none"];

/** External login providers (Amendment 1): generic OIDC, Google, GitHub. */
export type ProviderId = "oidc" | "google" | "github";

export const PROVIDER_IDS: readonly ProviderId[] = ["oidc", "google", "github"];

/** `GET /_ui/api/auth/state` */
export interface AuthState {
  mode: AuthMode;
  setupRequired: boolean;
  authenticated: boolean;
  user?: string | null;
  passwordLogin: boolean;
  /** Enabled and verified providers, one login button each. */
  providers: { id: ProviderId; name: string }[];
  jackett: { ok: boolean; version?: string; error?: string };
  version?: string;
}

/** A setting value plus whether it comes from an environment variable. */
export interface Locked<T> {
  value: T;
  locked: boolean;
}

/** Common part of every provider in `GET /_ui/api/settings`. */
export interface ProviderSettingsBase {
  clientId: Locked<string>;
  clientSecretSet: Locked<boolean>;
  redirectUrl: string;
  verified: boolean;
}

export interface OidcProviderSettings extends ProviderSettingsBase {
  issuer: Locked<string>;
  providerName: Locked<string>;
  scopes: Locked<string>;
  allowedGroups: Locked<string[]>;
  groupsClaim: Locked<string>;
  /** Accept email_verified=false for the e-mail allow-list (own IdP). */
  allowUnverifiedEmail?: Locked<boolean>;
}

/** `GET /_ui/api/settings` */
export interface UiSettings {
  auth: {
    mode: Locked<AuthMode>;
    passwordSet: Locked<boolean>;
    passwordFallback: Locked<boolean>;
    /** Any provider, verified emails only. */
    allowedEmails: Locked<string[]>;
    /** GitHub logins, case-insensitive. */
    githubUsers: Locked<string[]>;
    providers: {
      oidc: OidcProviderSettings;
      google: ProviderSettingsBase;
      github: ProviderSettingsBase;
    };
    header: {
      name: Locked<string>;
      trusted: Locked<string[]>;
    };
  };
  publicUrl: Locked<string>;
  sessionTtl: Locked<string>;
}

/** Provider fields as plain values (PUT patch / test request). Secret: "" or omitted = unchanged, null = clear. */
export interface ProviderFields {
  clientId?: string;
  clientSecret?: string | null;
  /** oidc only */
  issuer?: string;
  providerName?: string;
  scopes?: string;
  allowedGroups?: string[];
  groupsClaim?: string;
  allowUnverifiedEmail?: boolean;
}

/** `PUT /_ui/api/settings`: partial, omitted = unchanged. */
export interface UiSettingsPatch {
  auth?: {
    mode?: AuthMode;
    passwordFallback?: boolean;
    password?: { current?: string; new: string };
    allowedEmails?: string[];
    githubUsers?: string[];
    providers?: Partial<Record<ProviderId, ProviderFields>>;
    header?: { name?: string; trusted?: string[] };
  };
  publicUrl?: string;
  sessionTtl?: string;
  /** Required when switching to `none`. */
  confirm?: boolean;
}

/** Result of `GET /_ui/api/settings/providers/{id}/test/<token>`. */
export interface ProviderTestResult {
  status: "pending" | "verified" | "failed";
  message?: string;
}

const BASE = "/_ui/api";

interface CallOptions {
  /** Emit the "re-check auth state" signal on 401/setup_required (protected endpoints). */
  recheck?: boolean;
}

async function call<T>(path: string, init: RequestInit = {}, opts: CallOptions = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("X-Requested-With", "XMLHttpRequest");
  headers.set("Accept", "application/json");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  const res = await fetch(`${BASE}${path}`, { ...init, headers, credentials: "same-origin", redirect: "manual" });
  if (isAuthProxyRedirect(res)) {
    window.location.reload();
    throw new ApiError(401, "Сессия истекла, перезагружаю страницу…");
  }
  if (!res.ok) {
    const err = await errorFromResponse(res);
    if (opts.recheck) maybeRecheck(err);
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const body = (method: string, data: unknown): RequestInit => ({ method, body: JSON.stringify(data) });

/** Extracts the test token from the URL returned by `testProvider` (`…?test=<token>`). */
export function providerTestToken(url: string): string | null {
  try {
    return new URL(url, "http://x").searchParams.get("test");
  } catch {
    return null;
  }
}

export const serverApi = {
  authState: () => call<AuthState>("/auth/state"),

  /** First start: sets the admin password and logs in (204 + cookie). */
  setup: (password: string) => call<void>("/auth/setup", body("POST", { password })),

  login: (password: string) => call<void>("/auth/login", body("POST", { password })),

  logout: () => call<void>("/auth/logout", { method: "POST" }),

  /** Ends every session (bumps the auth epoch), including this one. */
  logoutAll: () => call<void>("/auth/logout-all", { method: "POST" }),

  getSettings: () => call<UiSettings>("/settings", {}, { recheck: true }),

  putSettings: (patch: UiSettingsPatch) => call<UiSettings | undefined>("/settings", body("PUT", patch), { recheck: true }),

  /**
   * Checks the provider settings (OIDC discovery for oidc/google) and returns the URL that starts
   * a test login (open it in a new tab). Unsaved fields can be tested; an empty secret = the stored one.
   */
  testProvider: (id: ProviderId, fields: ProviderFields) =>
    call<{ url: string }>(`/settings/providers/${id}/test`, body("POST", fields), { recheck: true }),

  testProviderResult: (id: ProviderId, token: string) =>
    call<ProviderTestResult>(`/settings/providers/${id}/test/${encodeURIComponent(token)}`, {}, { recheck: true }),
};

/** Full-page URL that starts the login with `provider` and comes back to `returnPath`. */
export function providerStartUrl(provider: ProviderId, returnPath: string): string {
  const safe = returnPath.startsWith("/") && !returnPath.startsWith("//") ? returnPath : "/";
  return `/_ui/auth/${provider}/start?return=${encodeURIComponent(safe)}`;
}

export type ProviderTestOutcome = "verified" | "failed" | "timeout" | "cancelled";

/**
 * Polls the result of a test login until it is verified, failed, `timeoutMs` passed or
 * `signal` aborted. Uses `GET /settings/providers/{id}/test/<token>`; if the server doesn't
 * have that endpoint (404), falls back to `GET /settings` → `auth.providers[id].verified`.
 */
export async function waitForProviderTest(
  id: ProviderId,
  token: string,
  {
    signal,
    intervalMs = 2000,
    timeoutMs = 10 * 60_000,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    onFailed,
  }: {
    signal?: AbortSignal;
    intervalMs?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onFailed?: (message?: string) => void;
  } = {},
): Promise<ProviderTestOutcome> {
  let useSettings = false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) return "cancelled";
    try {
      if (useSettings) {
        const s = await serverApi.getSettings();
        if (s.auth.providers[id].verified) return "verified";
      } else {
        const r = await serverApi.testProviderResult(id, token);
        if (r.status === "verified") return "verified";
        if (r.status === "failed") {
          onFailed?.(r.message);
          return "failed";
        }
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404 && !useSettings) {
        useSettings = true;
        continue;
      }
      if (e instanceof ApiError && e.status === 401) return "cancelled";
      // Transient errors: keep polling.
    }
    if (Date.now() >= deadline) return "timeout";
    await sleep(intervalMs);
  }
}
