import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, ApiError, onAuthRecheck, providerStartUrl, providerTestToken, serverApi, waitForProviderTest } from "@/api";
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
    await serverApi.login("secret123");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/_ui/api/auth/login");
    const h = new Headers(init?.headers);
    expect(h.get("X-Requested-With")).toBe("XMLHttpRequest");
    expect(h.get("Content-Type")).toBe("application/json");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ password: "secret123" });
  });

  it("parses auth state", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, authState()));
    await expect(serverApi.authState()).resolves.toMatchObject({ mode: "password", authenticated: true });
  });

  it("maps {error, message} to ApiError with code", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "invalid_credentials", message: "Неверный пароль" }));
    const e = await caught(serverApi.login("x"));
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
    const e = await caught(serverApi.login("x"));
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
    await caught(serverApi.login("x"));
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

describe("provider helpers", () => {
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
