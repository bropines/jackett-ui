/** Fixtures in the shape of docs/server-spec.md ("/_ui/api contract" + Amendment 1). */
import type { AuthState, ProviderSettingsBase, UiSettings } from "@/api/server";

export const authState = (over: Partial<AuthState> = {}): AuthState => ({
  mode: "password",
  setupRequired: false,
  authenticated: true,
  user: "admin",
  passwordLogin: true,
  providers: [],
  jackett: { ok: true, version: "v0.24.3003" },
  version: "0.2.0",
  ...over,
});

const L = <T,>(value: T, locked = false) => ({ value, locked });

const plain = (id: string, clientId = "", secretSet = false, verified = false, locked = false): ProviderSettingsBase => ({
  clientId: L(clientId, locked),
  clientSecretSet: L(secretSet, locked),
  redirectUrl: `https://jackett.example.com/_ui/auth/${id}/callback`,
  verified,
});

/** SSO mode: OIDC (Authentik) from env and verified, GitHub configured in the file, Google off. */
export const uiSettings = (): UiSettings => ({
  auth: {
    mode: L("sso" as const),
    passwordSet: L(true),
    passwordFallback: L(true),
    allowedEmails: L(["me@example.com"]),
    githubUsers: L(["octocat"]),
    providers: {
      oidc: {
        ...plain("oidc", "abc", true, true, true),
        issuer: L("https://auth.example.com/application/o/jackett/", true),
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
  },
  publicUrl: L(""),
  sessionTtl: L("168h", true),
});

/** Fresh install after setup: password mode, nothing from env, no provider configured. */
export const uiSettingsPassword = (): UiSettings => ({
  auth: {
    mode: L("password" as const),
    passwordSet: L(true),
    passwordFallback: L(true),
    allowedEmails: L<string[]>([]),
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
  },
  publicUrl: L(""),
  sessionTtl: L("168h"),
});

export function jsonResponse(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  if (body === undefined) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}
