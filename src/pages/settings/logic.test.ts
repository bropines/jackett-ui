import { describe, expect, it, vi } from "vitest";

import type { ServerConfig } from "@/api/types";
import { passwordError } from "@/pages/settings/AdminPasswordCard";
import { fromForm, hasErrors, humanSeconds, isDirty, isHttpUrl, proxyChanged, toForm, validate } from "@/pages/settings/logic";
import { pollUntilUp } from "@/pages/settings/restart";

const cfg: ServerConfig = {
  notices: [],
  port: 9117,
  external: true,
  local_bind_address: "127.0.0.1",
  cors: false,
  api_key: "0123456789abcdef0123456789abcdef",
  blackholedir: null,
  updatedisabled: true,
  prerelease: false,
  password: "",
  logging: false,
  basepathoverride: null,
  baseurloverride: null,
  cache_enabled: true,
  cache_ttl: 2100,
  cache_max_results_per_indexer: 1000,
  flaresolverrurl: null,
  flaresolverr_maxtimeout: 55000,
  omdbkey: null,
  omdburl: null,
  app_version: "v0.24.2994",
  can_run_netcore: false,
  proxy_type: 0,
  proxy_url: "172.17.0.1",
  proxy_port: 56990,
  proxy_username: null,
  proxy_password: null,
};

describe("form mapping", () => {
  it("round-trips the config unchanged", () => {
    expect(fromForm(toForm(cfg), cfg)).toEqual(cfg);
  });

  it("maps empty strings to null and parses numbers", () => {
    const f = { ...toForm(cfg), flaresolverrurl: " http://fs:8191 ", cache_ttl: "60", proxy_port: "", blackholedir: "  " };
    const out = fromForm(f, cfg);
    expect(out.flaresolverrurl).toBe("http://fs:8191");
    expect(out.cache_ttl).toBe(60);
    expect(out.proxy_port).toBeNull();
    expect(out.blackholedir).toBeNull();
    // Read-only and untouched keys are kept for the POST.
    expect(out.api_key).toBe(cfg.api_key);
    expect(out.port).toBe(9117);
  });
});

describe("isDirty", () => {
  it("is false for a fresh form and true after an edit", () => {
    const f = toForm(cfg);
    expect(isDirty(f, cfg)).toBe(false);
    expect(isDirty({ ...f, cors: true }, cfg)).toBe(true);
    expect(isDirty({ ...f, cache_ttl: "2101" }, cfg)).toBe(true);
  });
});

describe("validate", () => {
  it("accepts the live config", () => {
    expect(hasErrors(validate(toForm(cfg)))).toBe(false);
  });

  it("checks proxy port range only when proxy is enabled", () => {
    const f = toForm(cfg);
    expect(validate({ ...f, proxy_port: "0" }).proxy_port).toBeTruthy();
    expect(validate({ ...f, proxy_port: "65536" }).proxy_port).toBeTruthy();
    expect(validate({ ...f, proxy_port: "abc" }).proxy_port).toBeTruthy();
    expect(validate({ ...f, proxy_port: "65535" }).proxy_port).toBeUndefined();
    expect(validate({ ...f, proxy_port: "" }).proxy_port).toBeTruthy();
    expect(validate({ ...f, proxy_url: "" }).proxy_url).toBeTruthy();
    expect(hasErrors(validate({ ...f, proxy_type: -1, proxy_port: "0", proxy_url: "" }))).toBe(false);
  });

  it("requires non-negative integers", () => {
    const f = toForm(cfg);
    expect(validate({ ...f, cache_ttl: "-1" }).cache_ttl).toBeTruthy();
    expect(validate({ ...f, cache_ttl: "1.5" }).cache_ttl).toBeTruthy();
    expect(validate({ ...f, cache_ttl: "" }).cache_ttl).toBeTruthy();
    expect(validate({ ...f, cache_ttl: "0" }).cache_ttl).toBeUndefined();
    expect(validate({ ...f, flaresolverr_maxtimeout: "x" }).flaresolverr_maxtimeout).toBeTruthy();
    expect(validate({ ...f, cache_max_results_per_indexer: "-5" }).cache_max_results_per_indexer).toBeTruthy();
  });

  it("checks URLs", () => {
    const f = toForm(cfg);
    expect(validate({ ...f, flaresolverrurl: "flaresolverr:8191" }).flaresolverrurl).toBeTruthy();
    expect(validate({ ...f, flaresolverrurl: "http://flaresolverr:8191" }).flaresolverrurl).toBeUndefined();
    expect(validate({ ...f, baseurloverride: "ftp://x" }).baseurloverride).toBeTruthy();
    expect(validate({ ...f, omdburl: "https://www.omdbapi.com" }).omdburl).toBeUndefined();
    expect(validate({ ...f, basepathoverride: "jackett" }).basepathoverride).toBeTruthy();
    expect(validate({ ...f, basepathoverride: "/jackett" }).basepathoverride).toBeUndefined();
    expect(isHttpUrl("https://")).toBe(false);
  });
});

describe("proxyChanged", () => {
  it("detects proxy field changes only", () => {
    const same = fromForm({ ...toForm(cfg), cors: true, cache_ttl: "10" }, cfg);
    expect(proxyChanged(cfg, same)).toBe(false);
    expect(proxyChanged(cfg, fromForm({ ...toForm(cfg), proxy_type: 2 }, cfg))).toBe(true);
    expect(proxyChanged(cfg, fromForm({ ...toForm(cfg), proxy_port: "1080" }, cfg))).toBe(true);
    expect(proxyChanged(cfg, fromForm({ ...toForm(cfg), proxy_password: "x" }, cfg))).toBe(true);
    // "" in the form maps back to null: not a change.
    expect(proxyChanged(cfg, fromForm({ ...toForm(cfg), proxy_username: "" }, cfg))).toBe(false);
  });
});

describe("humanSeconds", () => {
  it("formats durations", () => {
    expect(humanSeconds(2100)).toBe("35 мин");
    expect(humanSeconds(3660)).toBe("1 ч 1 мин");
    expect(humanSeconds(45)).toBe("45 с");
    expect(humanSeconds(90000)).toBe("1 д 1 ч");
    expect(humanSeconds(0)).toBe("0 с");
  });
});

describe("passwordError", () => {
  it("flags mismatched passwords", () => {
    expect(passwordError("a", "b")).toBeTruthy();
    expect(passwordError("a", "a")).toBeUndefined();
    expect(passwordError("a", "")).toBeUndefined();
  });
});

describe("pollUntilUp", () => {
  const wait = () => Promise.resolve();

  it("returns once the probe succeeds", async () => {
    const probe = vi.fn().mockRejectedValueOnce(new Error("502")).mockRejectedValueOnce(new Error("502")).mockResolvedValue("ok");
    await expect(pollUntilUp(probe, { wait })).resolves.toBe("ok");
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("gives up after the timeout", async () => {
    const probe = vi.fn().mockRejectedValue(new Error("down"));
    await expect(pollUntilUp(probe, { wait, intervalMs: 2000, timeoutMs: 30000 })).resolves.toBeNull();
    expect(probe).toHaveBeenCalledTimes(15);
  });

  it("stops when cancelled", async () => {
    const probe = vi.fn().mockRejectedValue(new Error("down"));
    await expect(pollUntilUp(probe, { wait, isCancelled: () => true })).resolves.toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
});
