/** Fixtures in the JSON shapes of docs/spec-v0.3-users.md §5 and docs/spec-v0.4-auth.md. */
import type {
  ApiToken,
  AuthState,
  AuthUser,
  Invite,
  Me,
  MethodId,
  Passkey,
  ProviderSettingsBase,
  PublicInvite,
  Role,
  UiSettings,
  UserEntry,
} from "@/api/server";

export const adminUser: AuthUser = { id: "u_admin0000000000001", username: "admin", name: "Админ", role: "admin" };
export const editorUser: AuthUser = { id: "u_editor000000000001", username: "thero", name: "Thero", role: "editor" };
export const viewerUser: AuthUser = { id: "u_viewer000000000001", username: "guest", name: "Гость", role: "viewer" };

export const authState = (over: Partial<AuthState> = {}): AuthState => ({
  setupRequired: false,
  authenticated: true,
  disabled: false,
  user: adminUser,
  onboarding: false,
  methods: { password: true, passkey: false, providers: [], header: false },
  jackett: { ok: true, version: "v0.24.3003" },
  version: "0.4.0",
  ...over,
});

/** Logged-in state with the given role. */
export const authAs = (role: Role, over: Partial<AuthState> = {}): AuthState =>
  authState({ user: role === "admin" ? adminUser : role === "editor" ? editorUser : viewerUser, ...over });

export const token = (over: Partial<ApiToken> = {}): ApiToken => ({
  id: "t_qbit000000000001",
  name: "qBittorrent",
  prefix: "jui_Ab3d",
  createdAt: "2026-10-01T10:00:00Z",
  lastUsedAt: "2026-11-03T08:30:00Z",
  lastUsedIp: "192.168.1.20",
  expiresAt: null,
  ...over,
});

export const me = (over: Partial<Me> = {}): Me => ({
  user: { ...adminUser, email: "admin@example.com", passwordSet: true },
  identities: [{ provider: "github", label: "octocat", linkedAt: "2026-10-02T12:00:00Z" }],
  tokens: [token()],
  ...over,
});

export const passkey = (over: Partial<Passkey> = {}): Passkey => ({
  id: "pk_laptop000000001",
  name: "Windows",
  createdAt: "2026-10-01T10:00:00Z",
  lastUsedAt: "2026-11-03T08:30:00Z",
  synced: false,
  cloneWarning: false,
  ...over,
});

export const users = (): UserEntry[] => [
  {
    ...adminUser,
    email: "admin@example.com",
    bootstrap: true,
    passkeyCount: 1,
    disabled: false,
    identities: [{ provider: "oidc", label: "me@example.com", linkedAt: "2026-10-01T10:00:00Z" }],
    tokenCount: 2,
    lastLoginAt: "2026-11-04T09:00:00Z",
    createdAt: "2026-09-01T10:00:00Z",
  },
  {
    ...editorUser,
    disabled: false,
    identities: [{ provider: "github", label: "thero", linkedAt: "2026-10-05T10:00:00Z" }],
    tokenCount: 0,
    lastLoginAt: null,
    createdAt: "2026-10-05T10:00:00Z",
  },
  {
    ...viewerUser,
    disabled: true,
    identities: [],
    tokenCount: 1,
    lastLoginAt: "2026-10-20T10:00:00Z",
    createdAt: "2026-10-10T10:00:00Z",
  },
];

export const invites = (): Invite[] => [
  { id: "i_pending000000001", name: "Вася", role: "viewer", expiresAt: "2026-11-11T10:00:00Z", createdBy: adminUser.id },
];

export const publicInvite = (over: Partial<PublicInvite> = {}): PublicInvite => ({
  name: "Вася",
  role: "editor",
  expiresAt: "2026-11-11T10:00:00Z",
  methods: ["password", "github"],
  ...over,
});

const L = <T,>(value: T, locked = false, env?: string) => (env ? { value, locked, env } : { value, locked });

const plain = (id: string, clientId = "", secretSet = false, verified = false, locked = false): ProviderSettingsBase => ({
  clientId: L(clientId, locked),
  clientSecretSet: L(secretSet, locked),
  redirectUrl: `https://jackett.example.com/_ui/auth/${id}/callback`,
  verified,
});

const methods = (on: Partial<Record<MethodId, boolean>>, locked = false): UiSettings["auth"]["methods"] => ({
  password: L(!!on.password, locked, locked ? "AUTH_METHODS" : undefined),
  passkey: L(!!on.passkey, locked, locked ? "AUTH_METHODS" : undefined),
  oidc: L(!!on.oidc, locked, locked ? "AUTH_METHODS" : undefined),
  google: L(!!on.google, locked, locked ? "AUTH_METHODS" : undefined),
  github: L(!!on.github, locked, locked ? "AUTH_METHODS" : undefined),
  header: L(!!on.header, locked, locked ? "AUTH_METHODS" : undefined),
});

/** Password + OIDC (Authentik, from env, verified), GitHub configured in the file and verified but off, Google empty. */
export const uiSettings = (): UiSettings => ({
  auth: {
    methods: methods({ password: true, oidc: true }),
    disabled: L(false),
    autoProvision: { enabled: L(true), role: L<Role>("viewer") },
    allowedEmails: L(["me@example.com"]),
    adminEmails: L<string[]>([]),
    githubUsers: L(["octocat"]),
    providers: {
      oidc: {
        ...plain("oidc", "abc", true, true, true),
        issuer: L("https://auth.example.com/application/o/jackett/", true, "OIDC_ISSUER"),
        providerName: L("Authentik"),
        scopes: L("openid email profile"),
        allowedGroups: L<string[]>([]),
        groupsClaim: L("groups"),
      },
      google: plain("google"),
      github: plain("github", "gh-client", true, true),
    },
    header: {
      name: L("Remote-User"),
      trusted: L(["172.16.0.0/12"]),
    },
    passkey: { available: true, rpId: "jackett.example.com" },
  },
  publicUrl: L(""),
  sessionTtl: L("168h", true, "SESSION_TTL"),
});

/** Fresh install after setup: password only, nothing from env, no provider configured. */
export const uiSettingsPassword = (): UiSettings => ({
  auth: {
    methods: methods({ password: true }),
    disabled: L(false),
    autoProvision: { enabled: L(false), role: L<Role>("viewer") },
    allowedEmails: L<string[]>([]),
    adminEmails: L<string[]>([]),
    githubUsers: L<string[]>([]),
    providers: {
      oidc: {
        ...plain("oidc"),
        issuer: L(""),
        providerName: L(""),
        scopes: L("openid email profile"),
        allowedGroups: L<string[]>([]),
        groupsClaim: L("groups"),
      },
      google: plain("google"),
      github: plain("github"),
    },
    header: { name: L("Remote-User"), trusted: L<string[]>([]) },
    passkey: { available: false, rpId: "192.168.1.10", reason: "Passkey работает только по https-адресу с доменным именем (PUBLIC_URL)" },
  },
  publicUrl: L(""),
  sessionTtl: L("168h"),
});

/** Methods block locked by AUTH_METHODS. */
export const uiSettingsLockedMethods = (): UiSettings => {
  const s = uiSettings();
  s.auth.methods = methods({ password: true, oidc: true }, true);
  return s;
};

export function jsonResponse(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  if (body === undefined) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}
