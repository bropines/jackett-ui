import { describe, expect, it } from "vitest";

import {
  durationText,
  inSection,
  methodErrorTarget,
  methodPatch,
  methodState,
  parseDuration,
  parseSettingsTab,
  sectionErrors,
  SECTION_PATHS,
} from "@/pages/settings/sections";
import { uiSettings, uiSettingsLockedMethods, uiSettingsPassword } from "@/test/fixtures/auth";

describe("parseSettingsTab", () => {
  it("accepts known tabs, maps the old 'panel' and drops the rest", () => {
    expect(parseSettingsTab("users")).toBe("users");
    expect(parseSettingsTab("general")).toBe("general");
    expect(parseSettingsTab("panel")).toBe("login");
    expect(parseSettingsTab("nope")).toBeUndefined();
    expect(parseSettingsTab(undefined)).toBeUndefined();
  });
});

describe("section errors", () => {
  it("matches a path and everything below it", () => {
    expect(inSection("auth.header.name", SECTION_PATHS.header)).toBe(true);
    expect(inSection("auth.headerX", SECTION_PATHS.header)).toBe(false);
    expect(inSection("publicUrl", SECTION_PATHS.general)).toBe(true);
  });

  it("keeps only the section's non-empty errors", () => {
    const e = { "auth.allowedEmails": "bad", "auth.header.name": "x", publicUrl: "", "auth.autoProvision.role": "r" };
    expect(sectionErrors(e, SECTION_PATHS.signup)).toEqual({ "auth.allowedEmails": "bad", "auth.autoProvision.role": "r" });
    expect(sectionErrors(e, SECTION_PATHS.general)).toEqual({});
  });
});

describe("methodPatch", () => {
  it("sends the complete methods object with one switch flipped", () => {
    expect(methodPatch(uiSettings(), "github", true)).toEqual({
      auth: { methods: { password: true, passkey: false, oidc: true, google: false, github: true, header: false } },
    });
    expect(methodPatch(uiSettings(), "password", false).auth?.methods?.password).toBe(false);
  });
});

describe("methodState", () => {
  it("lets verified providers be switched on, blocks unconfigured ones", () => {
    const s = uiSettings();
    expect(methodState(s, "github")).toMatchObject({ on: false, configured: true, verified: true, canToggle: true });
    expect(methodState(s, "google")).toMatchObject({ configured: false, canToggle: false, reason: "Сначала нажмите «Настроить»" });
    expect(methodState(s, "oidc")).toMatchObject({ on: true, canToggle: true });
  });

  it("blocks a configured but unverified provider until tested; turning off is always allowed", () => {
    const s = uiSettingsPassword();
    s.auth.providers.google.clientId.value = "gid";
    expect(methodState(s, "google")).toMatchObject({ configured: true, verified: false, canToggle: false });
    s.auth.methods.google.value = true;
    expect(methodState(s, "google").canToggle).toBe(true);
  });

  it("needs header name and proxy networks before header login", () => {
    const s = uiSettingsPassword(); // trusted is empty
    expect(methodState(s, "header")).toMatchObject({ configured: false, canToggle: false });
    expect(methodState(uiSettings(), "header")).toMatchObject({ configured: true, canToggle: true });
  });

  it("is locked by AUTH_METHODS and when login is off", () => {
    expect(methodState(uiSettingsLockedMethods(), "password")).toMatchObject({ canToggle: false, reason: "задано переменной окружения AUTH_METHODS" });
    const off = uiSettings();
    off.auth.disabled.value = true;
    expect(methodState(off, "password").canToggle).toBe(false);
  });
});

describe("methodErrorTarget", () => {
  it("routes provider_not_ready to its method, the rest to the switched one", () => {
    expect(methodErrorTarget("auth.methods.oidc", "password")).toBe("oidc");
    expect(methodErrorTarget("auth.methods", "password")).toBe("password");
    expect(methodErrorTarget(undefined, "github")).toBe("github");
    expect(methodErrorTarget("auth.methods.bogus", "github")).toBe("github");
  });
});

describe("durations", () => {
  it("parses Go durations", () => {
    expect(parseDuration("168h")).toBe(604800);
    expect(parseDuration("1h30m")).toBe(5400);
    expect(parseDuration("90s")).toBe(90);
    expect(parseDuration("1 week")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });

  it("describes them in words", () => {
    expect(durationText("168h")).toBe("7 д");
    expect(durationText("1h30m")).toBe("1 ч 30 мин");
    expect(durationText("abc")).toBeUndefined();
  });
});
