import { describe, expect, it } from "vitest";

import {
  allowListsEmpty,
  buildPatch,
  errorPath,
  isCidr,
  isEmptyPatch,
  isLocked,
  lockedHint,
  P,
  providerFields,
  providerVerified,
  toAuthForm,
  validateAuthForm,
  verifyKey,
  type AuthForm,
} from "@/pages/settings/auth/logic";
import { uiSettings, uiSettingsLockedMethods, uiSettingsPassword } from "@/test/fixtures/auth";

const edit = (f: AuthForm, over: Partial<AuthForm>): AuthForm => ({ ...f, ...over });
const editProvider = (f: AuthForm, id: keyof AuthForm["providers"], over: Partial<AuthForm["providers"]["oidc"]>): AuthForm => ({
  ...f,
  providers: { ...f.providers, [id]: { ...f.providers[id], ...over } },
});

describe("toAuthForm", () => {
  it("maps settings to form values", () => {
    const f = toAuthForm(uiSettings());
    expect(f.methods).toEqual({ password: true, oidc: true, google: false, github: false, header: false });
    expect(f.disabled).toBe(false);
    expect(f.autoProvision).toBe(true);
    expect(f.defaultRole).toBe("viewer");
    expect(f.allowedEmails).toBe("me@example.com");
    expect(f.githubUsers).toBe("octocat");
    expect(f.providers.oidc).toMatchObject({ issuer: "https://auth.example.com/application/o/jackett/", clientId: "abc", providerName: "Authentik" });
    expect(f.providers.oidc.clientSecret).toBe("");
    expect(f.providers.github.clientId).toBe("gh-client");
    expect(f.headerTrusted).toBe("172.16.0.0/12");
    expect(f.sessionTtl).toBe("168h");
  });
});

describe("buildPatch", () => {
  it("is empty for an untouched form", () => {
    const s = uiSettings();
    expect(isEmptyPatch(buildPatch(toAuthForm(s), s))).toBe(true);
  });

  it("contains only changed fields", () => {
    const s = uiSettings();
    let f = toAuthForm(s);
    f = editProvider(f, "oidc", { providerName: "Keycloak", allowedGroups: "admins, ops" });
    f = edit(f, { allowedEmails: "me@example.com,\nyou@example.com", publicUrl: " https://j.example.com " });
    expect(buildPatch(f, s)).toEqual({
      auth: {
        allowedEmails: ["me@example.com", "you@example.com"],
        providers: { oidc: { providerName: "Keycloak", allowedGroups: ["admins", "ops"] } },
      },
      publicUrl: "https://j.example.com",
    });
  });

  it("treats an empty secret as unchanged, a typed one as new and clear as null", () => {
    const s = uiSettings();
    const f = toAuthForm(s);
    expect(buildPatch(editProvider(f, "github", { clientSecret: "" }), s)).toEqual({});
    expect(buildPatch(editProvider(f, "github", { clientSecret: "s3cret" }), s)).toEqual({
      auth: { providers: { github: { clientSecret: "s3cret" } } },
    });
    expect(buildPatch(editProvider(f, "github", { clearSecret: true }), s)).toEqual({
      auth: { providers: { github: { clientSecret: null } } },
    });
  });

  it("never writes locked fields", () => {
    const s = uiSettings();
    let f = toAuthForm(s);
    f = editProvider(f, "oidc", { issuer: "https://other.example.com/", clientId: "zzz", clientSecret: "new" });
    f = edit(f, { sessionTtl: "1h" });
    expect(buildPatch(f, s)).toEqual({});
  });

  it("sends the whole methods object when one method changes", () => {
    const s = uiSettings();
    const f = toAuthForm(s);
    expect(buildPatch(edit(f, { methods: { ...f.methods, github: true } }), s)).toEqual({
      auth: { methods: { password: true, oidc: true, google: false, github: true, header: false } },
    });
  });

  it("adds confirm when turning login off", () => {
    const s = uiSettings();
    expect(buildPatch(edit(toAuthForm(s), { disabled: true }), s)).toEqual({ auth: { disabled: true }, confirm: true });
  });

  it("patches auto-provision and admin e-mails", () => {
    const s = uiSettings();
    const f = edit(toAuthForm(s), { autoProvision: false, defaultRole: "editor", adminEmails: "boss@example.com" });
    expect(buildPatch(f, s)).toEqual({ auth: { autoProvision: { enabled: false, role: "editor" }, adminEmails: ["boss@example.com"] } });
  });

  it("never writes locked methods", () => {
    const s = uiSettingsLockedMethods();
    const f = toAuthForm(s);
    expect(buildPatch(edit(f, { methods: { ...f.methods, password: false } }), s)).toEqual({});
  });
});

describe("locks", () => {
  it("maps fields to env var names", () => {
    const s = uiSettings();
    expect(isLocked(s, P.provider("oidc", "issuer"))).toBe(true);
    expect(lockedHint(s, P.provider("oidc", "issuer"))).toBe("задано переменной окружения OIDC_ISSUER");
    expect(lockedHint(s, P.provider("oidc", "clientSecret"))).toBe("задано переменной окружения OIDC_CLIENT_SECRET");
    expect(lockedHint(s, P.sessionTtl)).toBe("задано переменной окружения SESSION_TTL");
    expect(lockedHint(s, P.provider("oidc", "providerName"))).toBeUndefined();
    s.auth.providers.github.clientId.locked = true;
    expect(lockedHint(s, P.provider("github", "clientId"))).toBe("задано переменной окружения GITHUB_CLIENT_ID");
    s.auth.githubUsers.locked = true;
    expect(lockedHint(s, P.githubUsers)).toBe("задано переменной окружения GITHUB_USERS");
    expect(lockedHint(uiSettingsLockedMethods(), P.methods)).toBe("задано переменной окружения AUTH_METHODS");
    expect(lockedHint(uiSettingsLockedMethods(), P.method("github"))).toBe("задано переменной окружения AUTH_METHODS");
  });

  it("maps server error paths to form paths", () => {
    expect(errorPath("auth.providers.google.clientSecretSet")).toBe("auth.providers.google.clientSecret");
    expect(errorPath("auth.methods")).toBe(P.methods);
    expect(errorPath(undefined)).toBeUndefined();
  });
});

describe("verification", () => {
  it("is lost when core fields change and regained by a test of exactly those values", () => {
    const s = uiSettings();
    const f = toAuthForm(s);
    expect(providerVerified(f, s, "github", {})).toBe(true);
    const changed = editProvider(f, "github", { clientId: "other" });
    expect(providerVerified(changed, s, "github", {})).toBe(false);
    expect(providerVerified(changed, s, "github", { github: verifyKey(changed, "github") })).toBe(true);
    // Non-core fields (button name, groups) keep the verification.
    expect(providerVerified(editProvider(f, "oidc", { providerName: "X" }), s, "oidc", {})).toBe(true);
  });

  it("sends the test fields without an unchanged secret", () => {
    const f = editProvider(toAuthForm(uiSettings()), "google", { clientId: " g-id " });
    expect(providerFields(f, "google")).toEqual({ clientId: "g-id" });
    expect(providerFields(editProvider(f, "google", { clientSecret: "x" }), "google")).toEqual({ clientId: "g-id", clientSecret: "x" });
  });
});

describe("validateAuthForm", () => {
  it("blocks a provider method until the provider is configured and verified", () => {
    const s = uiSettingsPassword();
    const f0 = toAuthForm(s);
    const f = edit(f0, { methods: { ...f0.methods, google: true } });
    expect(validateAuthForm(f, s, {})[P.method("google")]).toMatch(/Client ID/);
    const g = editProvider(f, "google", { clientId: "gid" });
    expect(validateAuthForm(g, s, {})[P.method("google")]).toMatch(/Проверить вход/);
    expect(validateAuthForm(g, s, { google: verifyKey(g, "google") })[P.method("google")]).toBeUndefined();
  });

  it("needs at least one method unless login is off", () => {
    const s = uiSettingsPassword();
    const f0 = toAuthForm(s);
    const none = edit(f0, { methods: { ...f0.methods, password: false } });
    expect(validateAuthForm(none, s, {})[P.methods]).toBe("Включите хотя бы один способ входа");
    expect(validateAuthForm(edit(none, { disabled: true }), s, {})[P.methods]).toBeUndefined();
  });

  it("validates admin e-mails", () => {
    const s = uiSettingsPassword();
    expect(validateAuthForm(edit(toAuthForm(s), { adminEmails: "boss" }), s, {})[P.adminEmails]).toMatch(/e-mail/);
  });

  it("needs trusted CIDRs for header mode", () => {
    const s = uiSettingsPassword();
    const f0 = toAuthForm(s);
    const f = edit(f0, { methods: { ...f0.methods, header: true } });
    expect(validateAuthForm(f, s, {})[P.headerTrusted]).toBeTruthy();
    expect(validateAuthForm(edit(f, { headerTrusted: "10.0.0.0/8, fd00::/8" }), s, {})[P.headerTrusted]).toBeUndefined();
    expect(validateAuthForm(edit(f, { headerTrusted: "10.0.0.1" }), s, {})[P.headerTrusted]).toMatch(/CIDR/);
  });

  it("validates URLs and durations", () => {
    const s = uiSettingsPassword();
    const f = toAuthForm(s);
    expect(validateAuthForm(edit(f, { publicUrl: "jackett.example.com" }), s, {})[P.publicUrl]).toBeTruthy();
    expect(validateAuthForm(edit(f, { sessionTtl: "a week" }), s, {})[P.sessionTtl]).toBeTruthy();
    expect(validateAuthForm(edit(f, { sessionTtl: "1h30m" }), s, {})[P.sessionTtl]).toBeUndefined();
  });
});

describe("helpers", () => {
  it("isCidr", () => {
    expect(isCidr("172.16.0.0/12")).toBe(true);
    expect(isCidr("::1/128")).toBe(true);
    expect(isCidr("300.1.1.1/8")).toBe(false);
    expect(isCidr("10.0.0.0/33")).toBe(false);
  });

  it("allowListsEmpty", () => {
    const f = toAuthForm(uiSettingsPassword());
    expect(allowListsEmpty(f)).toBe(true);
    expect(allowListsEmpty(editProvider(f, "oidc", { allowedGroups: "admins" }))).toBe(false);
  });
});
