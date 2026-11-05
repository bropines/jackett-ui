/**
 * Client for the jackett-ui server's own API (`/_ui/api/*`): authentication state, login/setup,
 * the current user (profile, API tokens), users and invites (admin) and the server settings.
 * See docs/server-spec.md and docs/spec-v0.3-users.md §5.
 */
import { ApiError, errorFromResponse, isAuthProxyRedirect, maybeRecheck } from "@/api/http";

/** External login providers: generic OIDC, Google, GitHub. */
export type ProviderId = "oidc" | "google" | "github";

export const PROVIDER_IDS: readonly ProviderId[] = ["oidc", "google", "github"];

/** Login methods toggled independently in `auth.methods`. */
export type MethodId = "password" | "passkey" | ProviderId | "header";

export const METHOD_IDS: readonly MethodId[] = ["password", "passkey", "oidc", "google", "github", "header"];

/** viewer = «Поиск», editor = «Редактор», admin = «Админ». */
export type Role = "viewer" | "editor" | "admin";

export const ROLES: readonly Role[] = ["viewer", "editor", "admin"];

/** The logged-in user as `auth/state` and `/me` report it. */
export interface AuthUser {
  id: string;
  username: string;
  name: string;
  role: Role;
  /** Optional, informational (v0.4). */
  email?: string;
}

/** `GET /_ui/api/auth/state` */
export interface AuthState {
  setupRequired: boolean;
  authenticated: boolean;
  /** Login is off: everyone is an anonymous admin. */
  disabled: boolean;
  user?: AuthUser | null;
  /** Logged in as the bootstrap user (AUTH_PASSWORD) and the first-login wizard isn't done: show it (v0.4). */
  onboarding?: boolean;
  methods: {
    password: boolean;
    /** Passkey login is on, available for this address and someone has a passkey (v0.4). */
    passkey?: boolean;
    /** Enabled and verified providers, one login button each. */
    providers: { id: ProviderId; name: string }[];
    header: boolean;
  };
  jackett: { ok: boolean; version?: string; error?: string };
  version?: string;
}

/** A linked external account. */
export interface Identity {
  provider: ProviderId;
  label: string;
  linkedAt?: string | null;
}

/** Personal API token (metadata only; the secret is shown once at creation). */
export interface ApiToken {
  id: string;
  name: string;
  /** First 8 chars, e.g. "jui_Ab3d". */
  prefix: string;
  createdAt: string;
  lastUsedAt?: string | null;
  lastUsedIp?: string | null;
  expiresAt?: string | null;
}

/** `POST /me/tokens` → the secret once plus the metadata. */
export interface CreatedToken extends ApiToken {
  token: string;
}

/** `GET /_ui/api/me` */
export interface Me {
  /** `passwordSet` (assumption): whether the user has a password; when false, no current password is asked. */
  user: AuthUser & { passwordSet?: boolean };
  identities: Identity[];
  tokens: ApiToken[];
}

/** One entry of `GET /_ui/api/users` (admin). */
export interface UserEntry extends AuthUser {
  disabled: boolean;
  identities: Identity[];
  tokenCount: number;
  lastLoginAt?: string | null;
  createdAt?: string | null;
  passwordSet?: boolean;
  /** The password comes from AUTH_PASSWORD[_HASH] (the initial admin). */
  bootstrap?: boolean;
  passkeyCount?: number;
}

export interface UserCreate {
  username: string;
  name: string;
  role: Role;
  password?: string;
  email?: string;
}

export interface UserPatch {
  name?: string;
  /** "" clears it. */
  email?: string;
  role?: Role;
  disabled?: boolean;
  password?: string;
}

/** `GET /_ui/api/me/passkeys` entry. */
export interface Passkey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string | null;
  /** Backed up / synced by the platform (iCloud Keychain, Google Password Manager…). */
  synced?: boolean;
  /** The sign counter went backwards: the authenticator may have been cloned; logins with it are refused. */
  cloneWarning?: boolean;
}

/** Start of a WebAuthn ceremony: `publicKey` is the options object in its JSON form. */
export interface PasskeyCeremony {
  ceremony: string;
  publicKey: unknown;
}

/** `POST /_ui/api/onboarding` */
export type OnboardingRequest =
  | { mode: "skip" }
  | { mode: "replace" | "add"; username: string; name: string; email?: string; password: string };

/** `POST /_ui/api/auth/setup` */
export interface SetupRequest {
  username?: string;
  name?: string;
  email?: string;
  password: string;
}

/** `GET /_ui/api/invites` (admin): pending invites. */
export interface Invite {
  id: string;
  name: string;
  role: Role;
  expiresAt: string;
  createdAt?: string | null;
  createdBy?: string | null;
}

/** `POST /_ui/api/invites` → the one-time URL (shown once). */
export interface CreatedInvite extends Partial<Invite> {
  url: string;
}

/**
 * `GET /_ui/api/invites/{token}` (public). `methods` is normalized by `inviteMethods()`:
 * the server may send method ids (`["password","oidc"]`), provider objects or the auth-state shape.
 */
export interface PublicInvite {
  name: string;
  role: Role;
  expiresAt?: string | null;
  methods?: unknown;
}

/** A setting value plus whether it comes from an environment variable (and which one). */
export interface Locked<T> {
  value: T;
  locked: boolean;
  env?: string;
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
    methods: Record<MethodId, Locked<boolean>>;
    disabled: Locked<boolean>;
    autoProvision: { enabled: Locked<boolean>; role: Locked<Role> };
    /** Any provider, verified emails only: who may be auto-provisioned. */
    allowedEmails: Locked<string[]>;
    /** Auto-provisioned users with these e-mails become admins. */
    adminEmails: Locked<string[]>;
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
    /** Whether passkeys work at the current public address (v0.4). */
    passkey?: { available: boolean; rpId?: string; reason?: string };
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
    /** Always the complete object when any method changed. */
    methods?: Record<MethodId, boolean>;
    disabled?: boolean;
    autoProvision?: { enabled?: boolean; role?: Role };
    allowedEmails?: string[];
    adminEmails?: string[];
    githubUsers?: string[];
    providers?: Partial<Record<ProviderId, ProviderFields>>;
    header?: { name?: string; trusted?: string[] };
  };
  publicUrl?: string;
  sessionTtl?: string;
  /** Required when turning login off (`auth.disabled: true`). */
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
const del: RequestInit = { method: "DELETE" };
const post: RequestInit = { method: "POST" };
const enc = encodeURIComponent;
const protectedCall = <T>(path: string, init: RequestInit = {}) => call<T>(path, init, { recheck: true });

/** Lists come as a bare array; `{<key>: [...]}` is accepted too. */
function asList<T>(r: unknown, key: string): T[] {
  if (Array.isArray(r)) return r as T[];
  const v = r && typeof r === "object" ? (r as Record<string, unknown>)[key] : undefined;
  return Array.isArray(v) ? (v as T[]) : [];
}

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

  /** First start: creates the first admin and logs in (204 + cookie). */
  setup: (data: SetupRequest) => call<void>("/auth/setup", body("POST", data)),

  login: (data: { username: string; password: string }) => call<void>("/auth/login", body("POST", data)),

  logout: () => call<void>("/auth/logout", post),

  /** Ends every session of the current user (bumps the user's epoch), including this one. */
  logoutAll: () => call<void>("/auth/logout-all", post),

  /** Passkey login, step 1 (public): a ceremony id plus the request options. */
  passkeyLoginBegin: () => call<PasskeyCeremony>("/auth/passkey/begin", post),

  /** Passkey login, step 2 (public): 204 + session cookie. */
  passkeyLoginFinish: (data: { ceremony: string; credential: unknown }) => call<void>("/auth/passkey/finish", body("POST", data)),

  /** First-login wizard: replace the initial admin, add another admin, or skip. */
  onboarding: (data: OnboardingRequest) => protectedCall<void>("/onboarding", body("POST", data)),

  /* ── Me ── */

  me: () => protectedCall<Me>("/me"),
  updateMe: (patch: { name?: string; email?: string }) => protectedCall<void>("/me", body("PATCH", patch)),
  changeMyPassword: (data: { current?: string; new: string }) => protectedCall<void>("/me/password", body("POST", data)),
  unlinkMyIdentity: (provider: ProviderId) => protectedCall<void>(`/me/identities/${enc(provider)}`, del),
  createMyToken: (data: { name: string; expiresInDays?: number }) => protectedCall<CreatedToken>("/me/tokens", body("POST", data)),
  deleteMyToken: (id: string) => protectedCall<void>(`/me/tokens/${enc(id)}`, del),
  myPasskeys: async () => asList<Passkey>(await protectedCall<unknown>("/me/passkeys"), "passkeys"),
  /** 409 `passkeys_unavailable` (message = why) when passkeys don't work at this address. */
  beginMyPasskey: () => protectedCall<PasskeyCeremony>("/me/passkeys/begin", post),
  finishMyPasskey: (data: { ceremony: string; name: string; credential: unknown }) => protectedCall<Passkey>("/me/passkeys/finish", body("POST", data)),
  renameMyPasskey: (id: string, name: string) => protectedCall<Passkey>(`/me/passkeys/${enc(id)}`, body("PATCH", { name })),
  /** 409 `would_lock_out` when it is the last way in. */
  deleteMyPasskey: (id: string) => protectedCall<void>(`/me/passkeys/${enc(id)}`, del),

  /* ── Users (admin) ── */

  users: async () => asList<UserEntry>(await protectedCall<unknown>("/users"), "users"),
  createUser: (data: UserCreate) => protectedCall<UserEntry | undefined>("/users", body("POST", data)),
  updateUser: (id: string, patch: UserPatch) => protectedCall<UserEntry | undefined>(`/users/${enc(id)}`, body("PATCH", patch)),
  deleteUser: (id: string) => protectedCall<void>(`/users/${enc(id)}`, del),
  logoutUser: (id: string) => protectedCall<void>(`/users/${enc(id)}/logout`, post),
  unlinkUserIdentity: (id: string, provider: ProviderId) => protectedCall<void>(`/users/${enc(id)}/identities/${enc(provider)}`, del),
  userTokens: async (id: string) => asList<ApiToken>(await protectedCall<unknown>(`/users/${enc(id)}/tokens`), "tokens"),
  deleteUserPasskey: (id: string, passkeyId: string) => protectedCall<void>(`/users/${enc(id)}/passkeys/${enc(passkeyId)}`, del),
  /** Revokes any user's token (admin). */
  deleteToken: (id: string) => protectedCall<void>(`/tokens/${enc(id)}`, del),

  /* ── Invites ── */

  invites: async () => asList<Invite>(await protectedCall<unknown>("/invites"), "invites"),
  createInvite: (data: { name: string; role: Role; expiresInDays: number }) => protectedCall<CreatedInvite>("/invites", body("POST", data)),
  deleteInvite: (id: string) => protectedCall<void>(`/invites/${enc(id)}`, del),
  /** Public: 404 = unknown, 410 = expired / used. */
  invite: (token: string) => call<PublicInvite>(`/invites/${enc(token)}`),
  /** Public: creates the user, consumes the invite and logs in (204 + cookie). */
  acceptInvite: (token: string, data: { username: string; password: string }) => call<void>(`/invites/${enc(token)}/accept`, body("POST", data)),

  /* ── Settings (admin) ── */

  getSettings: () => protectedCall<UiSettings>("/settings"),

  putSettings: (patch: UiSettingsPatch) => protectedCall<UiSettings | undefined>("/settings", body("PUT", patch)),

  /**
   * Checks the provider settings (OIDC discovery for oidc/google) and returns the URL that starts
   * a test login (open it in a new tab). Unsaved fields can be tested; an empty secret = the stored one.
   */
  testProvider: (id: ProviderId, fields: ProviderFields) => protectedCall<{ url: string }>(`/settings/providers/${id}/test`, body("POST", fields)),

  testProviderResult: (id: ProviderId, token: string) => protectedCall<ProviderTestResult>(`/settings/providers/${id}/test/${enc(token)}`),
};

const safeReturn = (path: string) => (path.startsWith("/") && !path.startsWith("//") ? path : "/");

/** Full-page URL that starts the login with `provider` and comes back to `returnPath`. */
export function providerStartUrl(provider: ProviderId, returnPath: string): string {
  return `/_ui/auth/${provider}/start?return=${enc(safeReturn(returnPath))}`;
}

/** Full-page URL that links `provider` to the logged-in user and comes back to `returnPath` (default /profile). */
export function providerLinkUrl(provider: ProviderId, returnPath = "/profile"): string {
  return `/_ui/auth/${provider}/start?link=1&return=${enc(safeReturn(returnPath))}`;
}

/** Full-page URL that accepts invite `token` by logging in with `provider`. */
export function providerInviteUrl(provider: ProviderId, token: string): string {
  return `/_ui/auth/${provider}/start?invite=${enc(token)}`;
}

const DEFAULT_PROVIDER_NAMES: Record<ProviderId, string> = { oidc: "SSO", google: "Google", github: "GitHub" };
const isProviderId = (v: unknown): v is ProviderId => typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);

/**
 * Normalizes `methods` of a public invite: `["password","oidc"]`, `[{id,name}]` or
 * `{password, providers:[{id,name}]}` → `{password, providers}`.
 */
export function inviteMethods(raw: unknown): { password: boolean; providers: { id: ProviderId; name: string }[] } {
  const out = { password: false, providers: [] as { id: ProviderId; name: string }[] };
  const addProvider = (v: unknown) => {
    if (isProviderId(v)) out.providers.push({ id: v, name: DEFAULT_PROVIDER_NAMES[v] });
    else if (v && typeof v === "object" && isProviderId((v as { id?: unknown }).id)) {
      const p = v as { id: ProviderId; name?: unknown };
      out.providers.push({ id: p.id, name: typeof p.name === "string" && p.name ? p.name : DEFAULT_PROVIDER_NAMES[p.id] });
    }
  };
  if (Array.isArray(raw)) {
    for (const m of raw) {
      if (m === "password" || (m && typeof m === "object" && (m as { id?: unknown }).id === "password")) out.password = true;
      else addProvider(m);
    }
  } else if (raw && typeof raw === "object") {
    const o = raw as { password?: unknown; providers?: unknown };
    out.password = o.password === true;
    if (Array.isArray(o.providers)) o.providers.forEach(addProvider);
  }
  return out;
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
