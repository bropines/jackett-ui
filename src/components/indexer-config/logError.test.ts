import { describe, expect, it } from "vitest";

import type { LogEntry } from "@/api";
import logs from "../../../contract/logs.json";

import { isVagueError, logHeadline, saveErrorFromLogs } from "./logError";

const flare: LogEntry = {
  Level: "Error",
  When: "2026-11-05T14:20:05+03:00",
  Message:
    "FlareSolverrSharp.Exceptions.FlareSolverrException: Challenge detected but FlareSolverr is not configured\n\n[v0.24.3003.0] FlareSolverrSharp.Exceptions.FlareSolverrException: Challenge detected but FlareSolverr is not configured\n   at Jackett.Common.Indexers.Definitions.RuTracker.ApplyConfiguration(JToken configJson)",
};
const since = Date.parse("2026-11-05T14:20:00+03:00");

describe("isVagueError", () => {
  it("spots generic texts", () => {
    for (const m of ["Internal Server Error", "HTTP 500", "", "502 Bad Gateway"]) expect(isVagueError(m)).toBe(true);
    expect(isVagueError("Challenge detected but FlareSolverr is not configured")).toBe(false);
  });
});

describe("logHeadline", () => {
  it("drops the exception type and the stack", () => {
    expect(logHeadline(flare.Message)).toBe("Challenge detected but FlareSolverr is not configured");
    expect(logHeadline("Jackett.Common.IndexerException: Exception (rutor): boom\n\nstack")).toBe("Exception (rutor): boom");
    expect(logHeadline("plain text")).toBe("plain text");
  });
});

describe("saveErrorFromLogs", () => {
  it("finds the tracker's error after the save started", () => {
    const old = { ...flare, When: "2026-11-05T14:00:00+03:00", Message: "Old: RuTracker died" };
    const other = { ...flare, Message: "Exception (rutor): boom" };
    const info = { Level: "Info", When: flare.When, Message: "RuTracker something" };
    expect(saveErrorFromLogs([old, other, info, flare], "rutracker", since)).toBe("Challenge detected but FlareSolverr is not configured");
  });

  it("falls back to the only error in the window, else nothing", () => {
    const anon = { ...flare, Message: "System.Exception: odd failure" };
    expect(saveErrorFromLogs([anon], "rutracker", since)).toBe("odd failure");
    expect(saveErrorFromLogs([anon, { ...anon, Message: "System.Exception: another" }], "rutracker", since)).toBeNull();
    expect(saveErrorFromLogs([], "rutracker", since)).toBeNull();
  });

  it("reads the captured log fixture", () => {
    const entries = logs as LogEntry[];
    const first = entries.find((l) => l.Level === "Error")!;
    expect(saveErrorFromLogs(entries, "rutor", Date.parse(first.When))).toMatch(/^Exception \(rutor\)/);
  });
});
