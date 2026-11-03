import { describe, expect, it } from "vitest";

import type { LogEntry } from "@/api/types";
import logsJson from "../../../contract/logs.json";
import { countByLevel, filterRows, firstLine, isMultiline, normalizeLevel, toRows } from "@/pages/logs/logic";

const logs = logsJson as LogEntry[];

describe("normalizeLevel", () => {
  it("maps Jackett/NLog levels", () => {
    expect(normalizeLevel("Error")).toBe("error");
    expect(normalizeLevel("Fatal")).toBe("error");
    expect(normalizeLevel("Warn")).toBe("warn");
    expect(normalizeLevel("Info")).toBe("info");
    expect(normalizeLevel("Debug")).toBe("debug");
    expect(normalizeLevel("Trace")).toBe("debug");
    expect(normalizeLevel("Weird")).toBe("info");
  });
});

describe("firstLine", () => {
  it("takes the first non-empty line of a stack trace", () => {
    const err = logs.find((l) => l.Level === "Error")!;
    expect(isMultiline(err.Message)).toBe(true);
    const line = firstLine(err.Message);
    expect(line).toMatch(/^Jackett\.Common\.IndexerException: Exception \(rutor\)/);
    expect(line).not.toContain("\n");
    expect(firstLine("\n\n  hello \nworld")).toBe("hello");
    expect(isMultiline("single line\n")).toBe(false);
  });
});

describe("toRows", () => {
  it("orders newest first and keeps the API order for equal timestamps", () => {
    const rows = toRows(logs);
    expect(rows).toHaveLength(logs.length);
    expect(rows[0]?.message).toContain("Manual search in RuTor");
    expect(rows.at(-1)?.message).toBe("Starting Jackett v0.24.2994");
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.time).toBeGreaterThanOrEqual(rows[i]!.time);
  });

  it("sorts an oldest-first input too", () => {
    const rows = toRows([...logs].reverse());
    expect(rows[0]?.message).toContain("Manual search in RuTor");
  });

  it("gives unique ids that survive new entries on top", () => {
    const rows = toRows(logs);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    const newer: LogEntry = { Level: "Info", Message: "new", When: "2026-11-03T03:00:00+03:00" };
    const again = toRows([newer, ...logs]);
    expect(again.slice(1).map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });
});

describe("filtering", () => {
  const rows = toRows(logs);

  it("counts levels", () => {
    expect(countByLevel(rows)).toEqual({ all: 49, error: 3, warn: 1, info: 45, debug: 0 });
  });

  it("filters by level and text", () => {
    expect(filterRows(rows, "error", "")).toHaveLength(3);
    expect(filterRows(rows, "all", "cardigann")).toHaveLength(6);
    expect(filterRows(rows, "info", "PROXY")).toHaveLength(2);
    // Search also looks inside stack traces.
    expect(filterRows(rows, "error", "EstablishProxyTunnelAsync").length).toBeGreaterThan(0);
    expect(filterRows(rows, "warn", "nothing-like-this")).toHaveLength(0);
  });
});
