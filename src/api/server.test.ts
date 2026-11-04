import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  api,
  ApiError,
  inviteMethods,
  onAuthRecheck,
  providerInviteUrl,
  providerLinkUrl,
  providerStartUrl,
  providerTestToken,
  searchUrl,
  serverApi,
  waitForProviderTest,
} from "@/api";
import { authState, jsonResponse, uiSettings } from "@/test/fixtures/auth";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function caught(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error("expected a rejection");
}

describe("serverApi transport", () => {
  it("sends X-Requested-With and JSON", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(204));
    await serverApi.login({ username: "admin", password: "secret123" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/_ui/api/auth/login");
    const h = new Headers(init?.headers);
    expect(h.get("X-Requested-With")).toBe("XMLHttpRequest");
    expect(h.get("Content-Type")).toBe("application/json");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ username: "admin", password: "secret123" });
  });

  it("parses auth state", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, authState()));
    await expect(serverApi.authState()).resolves.toMatchObject({ disabled: false, authenticated: true, user: { username: "admin", role: "admin" } });
  });

  it("maps {error, message} to ApiError with code", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "invalid_credentials", message: "Неверный пароль" }));
    const e = await caught(serverApi.login({ username: "admin", password: "x" }));
    expect(e.status).toBe(401);
    expect(e.code).toBe("invalid_credentials");
    expect(e.message).toBe("Неверный пароль");
  });

  it("falls back to a Russian text when the message is missing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(502, { error: "jackett_login_failed" }));
    const e = await caught(serverApi.getSettings());
    expect(e.code).toBe("jackett_login_failed");
    expect(e.message).toContain("JACKETT_PASSWORD");
  });

  it("reads Retry-After on 429", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: "rate_limited" }, { "Retry-After": "42" }));
    const e = await caught(serverApi.login({ username: "admin", password: "x" }));
    expect(e.retryAfter).toBe(42);
    expect(e.message).toBe("Слишком много попыток, подождите 42 с");
  });

  it("keeps the field path of locked / validation errors", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, { error: "locked", message: "Задано переменной окружения", field: "auth.providers.oidc.issuer" }),
    );
    const e = await caught(serverApi.putSettings({ auth: { providers: { oidc: { issuer: "https://x" } } } }));
    expect(e.code).toBe("locked");
    expect(e.field).toBe("auth.providers.oidc.issuer");
  });

  it("keeps Jackett error bodies as before", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { result: "error", error: "Challenge detected", stacktrace: "…" }));
    const e = await caught(api.testIndexer("rutor"));
    expect(e.status).toBe(500);
    expect(e.code).toBeUndefined();
    expect(e.message).toBe("Challenge detected");
  });

  it("signals the gate on 401 / setup_required from protected calls, not from login", async () => {
    const seen: string[] = [];
    const off = onAuthRecheck((r) => seen.push(r));
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "invalid_credentials" }));
    await caught(serverApi.login({ username: "admin", password: "x" }));
    expect(seen).toEqual([]);

    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "setup_required", message: "…" }));
    await caught(api.configuredIndexers());
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "unauthorized" }));
    await caught(serverApi.getSettings());
    fetchMock.mockResolvedValueOnce(jsonResponse(401));
    const e = await caught(api.logs());
    expect(e.message).toBe("Сессия истекла, войдите снова");
    off();
    expect(seen).toEqual(["setup_required", "unauthorized", "401"]);
  });

  it("does not log in to Jackett itself any more", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401));
    await caught(api.serverConfig());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/UI/Dashboard"))).toBe(false);
  });
});

describe("v0.3 endpoints", () => {
  const call = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i]!;
    return { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
  };

  it("setup sends username + password", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(204));
    await serverApi.setup({ username: "boss", password: "longenough" });
    expect(call()).toEqual({ url: "/_ui/api/auth/setup", method: "POST", body: { username: "boss", password: "longenough" } });
  });

  it("profile endpoints", async () => {
    fetchMock.mockResolvedValue(jsonResponse(204));
    await serverApi.updateMe({ name: "Я" });
    await serverApi.changeMyPassword({ current: "old-password", new: "new-password" });
    await serverApi.unlinkMyIdentity("github");
    await serverApi.deleteMyToken("t_1");
    expect([call(0), call(1), call(2), call(3)]).toEqual([
      { url: "/_ui/api/me", method: "PATCH", body: { name: "Я" } },
      { url: "/_ui/api/me/password", method: "POST", body: { current: "old-password", new: "new-password" } },
      { url: "/_ui/api/me/identities/github", method: "DELETE", body: undefined },
      { url: "/_ui/api/me/tokens/t_1", method: "DELETE", body: undefined },
    ]);
  });

  it("creates a token and returns the secret", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: "jui_secret", id: "t_1", name: "qB", prefix: "jui_secr", createdAt: "x" }));
    await expect(serverApi.createMyToken({ name: "qB", expiresInDays: 30 })).resolves.toMatchObject({ token: "jui_secret" });
    expect(call()).toEqual({ url: "/_ui/api/me/tokens", method: "POST", body: { name: "qB", expiresInDays: 30 } });
  });

  it("users and invites (admin)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(204));
    await serverApi.updateUser("u_1", { role: "editor" });
    await serverApi.logoutUser("u_1");
    await serverApi.unlinkUserIdentity("u_1", "oidc");
    await serverApi.deleteToken("t_9");
    await serverApi.deleteInvite("i_1");
    expect([call(0), call(1), call(2), call(3), call(4)].map((c) => `${c.method} ${c.url}`)).toEqual([
      "PATCH /_ui/api/users/u_1",
      "POST /_ui/api/users/u_1/logout",
      "DELETE /_ui/api/users/u_1/identities/oidc",
      "DELETE /_ui/api/tokens/t_9",
      "DELETE /_ui/api/invites/i_1",
    ]);
    expect(call(0).body).toEqual({ role: "editor" });
  });

  it("accepts lists as arrays or wrapped", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [{ id: "u_1" }])).mockResolvedValueOnce(jsonResponse(200, { users: [{ id: "u_2" }] }));
    await expect(serverApi.users()).resolves.toEqual([{ id: "u_1" }]);
    await expect(serverApi.users()).resolves.toEqual([{ id: "u_2" }]);
  });

  it("maps new error codes and 403", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: "last_admin" }));
    expect((await caught(serverApi.updateUser("u_1", { role: "viewer" }))).message).toBe("Нельзя убрать последнего администратора");
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: "identity_in_use" }));
    expect((await caught(serverApi.unlinkMyIdentity("oidc"))).code).toBe("identity_in_use");
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: "forbidden" }));
    const e = await caught(api.logs());
    expect(e.status).toBe(403);
    expect(e.message).toBe("Недостаточно прав");
    fetchMock.mockResolvedValueOnce(new Response("", { status: 403 }));
    expect((await caught(api.indexerConfig("rutor"))).message).toBe("Недостаточно прав");
  });

  it("public invite: get and accept", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { name: "A", role: "viewer", methods: ["password"] })).mockResolvedValueOnce(jsonResponse(204));
    await serverApi.invite("tok/1");
    await serverApi.acceptInvite("tok/1", { username: "a", password: "longenough" });
    expect(call(0).url).toBe("/_ui/api/invites/tok%2F1");
    expect(call(1)).toEqual({ url: "/_ui/api/invites/tok%2F1/accept", method: "POST", body: { username: "a", password: "longenough" } });
  });
});

describe("search without the Jackett key", () => {
  it("builds the search URL without apikey", () => {
    const url = searchUrl({ query: "dune", trackers: ["rutor"], categories: [2000] });
    expect(url.startsWith("/api/v2.0/indexers/all/results?")).toBe(true);
    const q = new URL(url, "http://x").searchParams;
    expect(q.has("apikey")).toBe(false);
    expect(q.get("Query")).toBe("dune");
    expect(q.getAll("Tracker[]")).toEqual(["rutor"]);
  });

  it("search request carries no apikey", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { Results: [], Indexers: [] }));
    await api.search({ query: "x" });
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain("apikey");
  });

  it("never sends api_key back when saving Jackett settings", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(204));
    await api.saveServerConfig({ api_key: "(hidden)", port: 9117 } as never);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ port: 9117 });
  });
});

describe("provider helpers", () => {
  it("builds link and invite URLs", () => {
    expect(providerLinkUrl("github")).toBe("/_ui/auth/github/start?link=1&return=%2Fprofile");
    expect(providerInviteUrl("oidc", "abc")).toBe("/_ui/auth/oidc/start?invite=abc");
  });

  it("normalizes invite methods", () => {
    expect(inviteMethods(["password", "github"])).toEqual({ password: true, providers: [{ id: "github", name: "GitHub" }] });
    expect(inviteMethods([{ id: "oidc", name: "Authentik" }])).toEqual({ password: false, providers: [{ id: "oidc", name: "Authentik" }] });
    expect(inviteMethods({ password: true, providers: [{ id: "google", name: "Google" }], header: false })).toEqual({
      password: true,
      providers: [{ id: "google", name: "Google" }],
    });
    expect(inviteMethods(undefined)).toEqual({ password: false, providers: [] });
  });

  it("builds start URLs with a safe return path", () => {
    expect(providerStartUrl("github", "/indexers?add=1")).toBe("/_ui/auth/github/start?return=%2Findexers%3Fadd%3D1");
    expect(providerStartUrl("oidc", "//evil.example.com")).toBe("/_ui/auth/oidc/start?return=%2F");
    expect(providerStartUrl("google", "https://evil.example.com")).toBe("/_ui/auth/google/start?return=%2F");
  });

  it("extracts the test token", () => {
    expect(providerTestToken("/_ui/auth/oidc/start?test=tok123")).toBe("tok123");
    expect(providerTestToken("/_ui/auth/oidc/start")).toBeNull();
  });

  it("posts the test to the provider endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { url: "/_ui/auth/google/start?test=t" }));
    await serverApi.testProvider("google", { clientId: "id" });
    expect(fetchMock.mock.calls[0]![0]).toBe("/_ui/api/settings/providers/google/test");
  });
});

describe("waitForProviderTest", () => {
  const sleep = () => Promise.resolve();

  it("polls the token endpoint until verified", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { status: "pending" }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "verified" }));
    await expect(waitForProviderTest("oidc", "tok", { sleep })).resolves.toBe("verified");
    expect(fetchMock.mock.calls[0]![0]).toBe("/_ui/api/settings/providers/oidc/test/tok");
  });

  it("reports failures with the server message", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: "failed", message: "user_not_allowed" }));
    const onFailed = vi.fn();
    await expect(waitForProviderTest("github", "tok", { sleep, onFailed })).resolves.toBe("failed");
    expect(onFailed).toHaveBeenCalledWith("user_not_allowed");
  });

  it("falls back to GET /settings when the token endpoint is missing", async () => {
    const pending = uiSettings();
    pending.auth.providers.google.verified = false;
    const done = uiSettings();
    done.auth.providers.google.verified = true;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, { error: "not_found" }))
      .mockResolvedValueOnce(jsonResponse(200, pending))
      .mockResolvedValueOnce(jsonResponse(200, done));
    await expect(waitForProviderTest("google", "tok", { sleep })).resolves.toBe("verified");
    expect(fetchMock.mock.calls[1]![0]).toBe("/_ui/api/settings");
  });

  it("stops when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(waitForProviderTest("oidc", "tok", { sleep, signal: ac.signal })).resolves.toBe("cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
