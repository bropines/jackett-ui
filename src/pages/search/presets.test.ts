import { describe, expect, it } from "vitest";

import {
  applicableTrackers,
  loadPresets,
  parsePresets,
  PRESETS_KEY,
  presetMatches,
  removePreset,
  savePresets,
  upsertPreset,
  type TrackerPreset,
} from "./presets";

const p = (id: string, name: string, trackers: string[]): TrackerPreset => ({ id, name, trackers });

describe("presets storage", () => {
  it("parsePresets tolerates garbage and drops broken entries", () => {
    expect(parsePresets(null)).toEqual([]);
    expect(parsePresets("not json")).toEqual([]);
    expect(parsePresets('{"a":1}')).toEqual([]);
    const raw = JSON.stringify([
      p("1", " Русские ", ["rutor", "rutor", "kinozal"]),
      { id: "2", name: "", trackers: ["x"] },
      { id: "3", name: "empty", trackers: [] },
      { id: 4, name: "bad id", trackers: ["x"] },
      null,
      { id: "5", name: "mixed", trackers: ["a", 7, ""] },
    ]);
    expect(parsePresets(raw)).toEqual([p("1", "Русские", ["rutor", "kinozal"]), p("5", "mixed", ["a"])]);
  });

  it("load/save round-trip through a storage", () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(savePresets([p("1", "A", ["a"])], storage)).toBe(true);
    expect(mem.has(PRESETS_KEY)).toBe(true);
    expect(loadPresets(storage)).toEqual([p("1", "A", ["a"])]);
  });

  it("storage errors do not throw", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(loadPresets(broken)).toEqual([]);
    expect(savePresets([p("1", "A", ["a"])], broken)).toBe(false);
  });
});

describe("preset editing", () => {
  it("upsertPreset adds, replaces by name (case-insensitive) and ignores empty input", () => {
    const one = upsertPreset([], "Фильмы", ["a", "b", "a"], "id1");
    expect(one).toEqual([p("id1", "Фильмы", ["a", "b"])]);
    const two = upsertPreset(one, "фильмы", ["c"], "id2");
    expect(two).toEqual([p("id1", "фильмы", ["c"])]);
    expect(upsertPreset(two, "  ", ["x"])).toEqual(two);
    expect(upsertPreset(two, "X", [])).toEqual(two);
  });

  it("removePreset", () => {
    expect(removePreset([p("1", "A", ["a"]), p("2", "B", ["b"])], "1")).toEqual([p("2", "B", ["b"])]);
  });

  it("applicableTrackers and presetMatches ignore trackers that are no longer configured", () => {
    const pr = p("1", "A", ["a", "gone", "b"]);
    expect(applicableTrackers(pr, ["b", "a", "c"])).toEqual(["a", "b"]);
    expect(presetMatches(pr, ["b", "a"], ["a", "b", "c"])).toBe(true);
    expect(presetMatches(pr, ["a"], ["a", "b", "c"])).toBe(false);
    expect(presetMatches(p("2", "B", ["gone"]), [], ["a"])).toBe(false);
  });
});
