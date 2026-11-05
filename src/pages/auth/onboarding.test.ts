import { describe, expect, it } from "vitest";

import { onboardingBody, serverErrorField, setupBody, validateAccount, type AccountForm } from "@/pages/auth/onboarding";
import { enableMethodPatch, providerErrors, providerStatus } from "@/pages/welcome/logic";
import { uiSettings, uiSettingsPassword } from "@/test/fixtures/auth";

const form = (over: Partial<AccountForm> = {}): AccountForm => ({
  username: " Bropines ",
  name: " Bropines ",
  email: " Me@Example.com ",
  password: "longenough1",
  repeat: "longenough1",
  ...over,
});

describe("account form", () => {
  it("maps the wizard form to the onboarding body", () => {
    expect(onboardingBody("replace", form())).toEqual({
      mode: "replace",
      username: "bropines",
      name: "Bropines",
      email: "me@example.com",
      password: "longenough1",
    });
    expect(onboardingBody("add", form({ email: "  " }))).toEqual({ mode: "add", username: "bropines", name: "Bropines", password: "longenough1" });
  });

  it("maps the setup form, omitting empty name and e-mail", () => {
    expect(setupBody(form({ name: "", email: "" }))).toEqual({ username: "bropines", password: "longenough1" });
    expect(setupBody(form())).toEqual({ username: "bropines", name: "Bropines", email: "me@example.com", password: "longenough1" });
  });

  it("validates username, e-mail and password", () => {
    expect(validateAccount(form())).toEqual({});
    expect(validateAccount(form({ username: "", email: "nope", password: "short", repeat: "short" }))).toEqual({
      username: "Укажите имя пользователя",
      email: "Адрес вида name@example.com",
      password: "Минимум 8 символов",
    });
    expect(validateAccount(form({ email: "a b@c" })).email).toBeDefined();
    expect(validateAccount(form({ repeat: "other-password" })).password).toBe("Пароли не совпадают");
  });

  it("routes server errors to fields", () => {
    expect(serverErrorField("username_taken", undefined)).toBe("username");
    expect(serverErrorField("email_taken", "email")).toBe("email");
    expect(serverErrorField("invalid_email", undefined)).toBe("email");
    expect(serverErrorField("rate_limited", undefined)).toBeUndefined();
  });
});

describe("welcome page logic", () => {
  it("switches one method on and sends the complete methods object", () => {
    expect(enableMethodPatch(uiSettings(), "github")).toEqual({
      auth: { methods: { password: true, passkey: false, oidc: true, google: false, github: true, header: false } },
    });
    expect(enableMethodPatch(uiSettingsPassword(), "passkey").auth?.methods?.passkey).toBe(true);
  });

  it("reports provider status", () => {
    const s = uiSettings();
    expect(providerStatus(s, "oidc")).toEqual({ configured: true, verified: true, on: true });
    expect(providerStatus(s, "github")).toEqual({ configured: true, verified: true, on: false });
    expect(providerStatus(s, "google")).toEqual({ configured: false, verified: false, on: false });
  });

  it("keeps only one provider's errors", () => {
    expect(providerErrors({ "auth.providers.oidc.issuer": "x", "auth.providers.github.clientId": "y", publicUrl: "z" }, "oidc")).toEqual({
      "auth.providers.oidc.issuer": "x",
    });
  });
});
