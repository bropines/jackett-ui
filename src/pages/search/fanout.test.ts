import { describe, expect, it, vi } from "vitest";

import { ApiError, type SearchResponse } from "@/api";
import sample from "../../../contract/results-all.json";

import { mergeTrackers, trackerErrorText, TrackerTimeout, withTimeout } from "./fanout";

const rutor = sample as SearchResponse;

describe("mergeTrackers", () => {
  it("joins answers, keeps errors and lists the trackers still searching", () => {
    const m = mergeTrackers([
      { id: "rutor", name: "RuTor", status: "done", data: rutor },
      { id: "slow", name: "Slow", status: "pending" },
      { id: "bad", name: "Bad", status: "error", error: "Не ответил за 90 с", elapsed: 90_000 },
      { id: "gone", name: "Gone", status: "cancelled" },
    ]);
    expect(m.Results).toHaveLength(rutor.Results.length);
    expect(m.Indexers.map((i) => [i.ID, i.Status])).toEqual([...rutor.Indexers.map((i) => [i.ID, i.Status]), ["bad", 1]]);
    expect(m.Indexers.at(-1)).toMatchObject({ Error: "Не ответил за 90 с", ElapsedTime: 90_000 });
    expect(m.pending).toEqual([{ ID: "slow", Name: "Slow" }]);
    expect(m.any).toBe(true);
  });

  it("fills in a status when Jackett returned none", () => {
    const m = mergeTrackers([{ id: "x", name: "X", status: "done", data: { Results: [], Indexers: [] } }]);
    expect(m.Indexers).toEqual([{ ID: "x", Name: "X", Status: 2, Results: 0, Error: null, ElapsedTime: 0 }]);
  });

  it("is empty while everything is pending", () => {
    expect(mergeTrackers([{ id: "a", name: "A", status: "pending" }])).toMatchObject({ any: false, Results: [] });
  });
});

describe("trackerErrorText", () => {
  it("names timeouts and dropped connections plainly", () => {
    expect(trackerErrorText(new TrackerTimeout(90_000))).toBe("Не ответил за 90 с");
    expect(trackerErrorText(new ApiError(524, "error code: 524"))).toMatch(/100 с/);
    expect(trackerErrorText(new TypeError("Failed to fetch"))).toBe("Соединение оборвалось");
    expect(trackerErrorText(new ApiError(500, "Exception (rutor): boom"))).toBe("Exception (rutor): boom");
  });
});

describe("withTimeout", () => {
  it("turns a timeout into TrackerTimeout and passes other errors through", async () => {
    vi.useFakeTimers();
    const hang = (s: AbortSignal) => new Promise<never>((_, rej) => s.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    const p = withTimeout(undefined, 1000, hang);
    vi.advanceTimersByTime(1000);
    await expect(p).rejects.toBeInstanceOf(TrackerTimeout);

    const outer = new AbortController();
    const q = withTimeout(outer.signal, 1000, hang);
    outer.abort();
    await expect(q).rejects.toMatchObject({ name: "AbortError" });
    await expect(withTimeout(undefined, 1000, async () => 42)).resolves.toBe(42);
    vi.useRealTimers();
  });
});
