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
import { uiSettings, uiSettingsPassword } from "@/test/fixtures/auth";

const edit = (f: AuthForm, over: Partial<AuthForm>): AuthForm => ({ ...f, ...over });
const editProvider = (f: AuthForm, id: keyof AuthForm["providers"], over: Partial<AuthForm["providers"]["oidc"]>): AuthForm => ({
  ...f,
  providers: { ...f.providers, [id]: { ...f.providers[id], ...over } },
});

describe("toAuthForm", () => {
  it("maps settings to form values", () => {
    const f = toAuthForm(uiSettings());
    expect(f.mode).toBe("sso");
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

  it("adds confirm when switching to none", () => {
    const s = uiSettings();
    expect(buildPatch(edit(toAuthForm(s), { mode: "none" }), s)).toEqual({ auth: { mode: "none" }, confirm: true });
  });

  it("sends current + new password only when a password is typed", () => {
    const s = uiSettings();
    const f = edit(toAuthForm(s), { pwCurrent: "old-password", pwNew: "new-password", pwRepeat: "new-password" });
    expect(buildPatch(f, s)).toEqual({ auth: { password: { current: "old-password", new: "new-password" } } });
    const noPw = uiSettingsPassword();
    noPw.auth.passwordSet.value = false;
    expect(buildPatch(edit(toAuthForm(noPw), { pwNew: "new-password" }), noPw)).toEqual({ auth: { password: { new: "new-password" } } });
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
    s.auth.passwordSet.locked = true;
    expect(lockedHint(s, P.passwordCurrent)).toContain("AUTH_PASSWORD");
  });

  it("maps server error paths to form paths", () => {
    expect(errorPath("auth.providers.google.clientSecretSet")).toBe("auth.providers.google.clientSecret");
    expect(errorPath("auth.password.current")).toBe(P.passwordCurrent);
    expect(errorPath("auth.password.new")).toBe(P.password);
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
  it("blocks switching to sso without a verified provider", () => {
    const s = uiSettingsPassword();
    const f = edit(toAuthForm(s), { mode: "sso" });
    expect(validateAuthForm(f, s, {})[P.mode]).toMatch(/Проверить вход/);
    const g = editProvider(f, "google", { clientId: "gid" });
    expect(validateAuthForm(g, s, { google: verifyKey(g, "google") })[P.mode]).toBeUndefined();
  });

  it("checks passwords", () => {
    const s = uiSettings();
    const base = toAuthForm(s);
    expect(validateAuthForm(edit(base, { pwNew: "short" }), s, {})[P.password]).toBe("Минимум 8 символов");
    const e = validateAuthForm(edit(base, { pwNew: "long-enough", pwRepeat: "different!" }), s, {});
    expect(e[P.passwordRepeat]).toBe("Пароли не совпадают");
    expect(e[P.passwordCurrent]).toBe("Введите текущий пароль");
  });

  it("needs trusted CIDRs for header mode", () => {
    const s = uiSettingsPassword();
    const f = edit(toAuthForm(s), { mode: "header" });
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
