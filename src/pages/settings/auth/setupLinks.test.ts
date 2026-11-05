import { describe, expect, it } from "vitest";

import { providerSetupLinks } from "./setupLinks";

describe("providerSetupLinks", () => {
  it("pre-fills the GitHub form", () => {
    const u = new URL(providerSetupLinks("github", "https://jask.bropinus.ru/_ui/auth/github/callback")[0]!.href);
    expect(u.origin + u.pathname).toBe("https://github.com/settings/applications/new");
    expect(u.searchParams.get("oauth_application[name]")).toBe("Jackett");
    expect(u.searchParams.get("oauth_application[url]")).toBe("https://jask.bropinus.ru");
    expect(u.searchParams.get("oauth_application[callback_url]")).toBe("https://jask.bropinus.ru/_ui/auth/github/callback");
  });

  it("skips the homepage for a bad redirect URL", () => {
    const u = new URL(providerSetupLinks("github", "")[0]!.href);
    expect(u.searchParams.has("oauth_application[url]")).toBe(false);
    expect(u.searchParams.has("oauth_application[callback_url]")).toBe(false);
  });

  it("links Google Cloud Console", () => {
    const links = providerSetupLinks("google", "https://x.example/cb");
    expect(links.map((l) => new URL(l.href).host)).toEqual(["console.cloud.google.com", "console.cloud.google.com"]);
  });

  it("has nothing for OIDC", () => {
    expect(providerSetupLinks("oidc", "https://x.example/cb")).toEqual([]);
  });
});
