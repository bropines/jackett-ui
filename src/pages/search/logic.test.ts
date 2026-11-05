import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SearchResponse, SearchResult } from "@/api";

import {
  categoryLabel,
  commitDraft,
  draftFromSelection,
  onlyShown,
  splitChips,
  defaultDesc,
  filterRows,
  firstLine,
  formatElapsed,
  formatSize,
  joinIds,
  parseCategories,
  parseDate,
  parseIdList,
  seedTone,
  sortRows,
  toggle,
  toRows,
  trackersParam,
} from "./logic";

const fixture = JSON.parse(readFileSync(join(process.cwd(), "contract/results-all.json"), "utf8")) as SearchResponse;
const base = fixture.Results[0] as SearchResult;
const mk = (p: Partial<SearchResult>): SearchResult => ({ ...base, ...p });

describe("URL params", () => {
  it("parses id lists: trims, drops empties and duplicates, keeps order", () => {
    expect(parseIdList(undefined)).toEqual([]);
    expect(parseIdList("")).toEqual([]);
    expect(parseIdList(" rutor, kinozal,,rutor ")).toEqual(["rutor", "kinozal"]);
  });

  it("parses categories as sorted unique positive integers", () => {
    expect(parseCategories("5000,2000,abc,-1,2000,1.5,100003")).toEqual([2000, 5000, 100003]);
    expect(parseCategories(undefined)).toEqual([]);
  });

  it("joins ids sorted (numeric when all numeric), empty → undefined", () => {
    expect(joinIds([])).toBeUndefined();
    expect(joinIds([5000, 2000, 10000])).toBe("2000,5000,10000");
    expect(joinIds(["rutracker", "kinozal", "rutracker"])).toBe("kinozal,rutracker");
  });

  it("round-trips categories", () => {
    expect(parseCategories(joinIds([8000, 2000]))).toEqual([2000, 8000]);
  });

  it("drops the tracker param when the selection means all", () => {
    const configured = ["a", "b", "c"];
    expect(trackersParam([], configured)).toBeUndefined();
    expect(trackersParam(["c", "a", "b"], configured)).toBeUndefined();
    expect(trackersParam(["b", "a"], configured)).toBe("a,b");
    // Unknown configured list (still loading): keep the selection as is.
    expect(trackersParam(["x"], [])).toBe("x");
  });

  it("toggles list items", () => {
    expect(toggle([1, 2], 2)).toEqual([1]);
    expect(toggle([1], 3)).toEqual([1, 3]);
  });
});

describe("formatting", () => {
  it("formats sizes in binary units with a Russian decimal comma", () => {
    expect(formatSize(null)).toBe("—");
    expect(formatSize(512)).toBe("512 Б");
    expect(formatSize(1536)).toBe("1,5 КБ");
    expect(formatSize(1024 ** 3)).toBe("1,0 ГБ");
    expect(formatSize(base.Size)).toBe("4,4 ГБ"); // 4713726607 B
    expect(formatSize(150 * 1024 ** 2)).toBe("150 МБ");
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(230)).toBe("230 мс");
    expect(formatElapsed(1400)).toBe("1,4 с");
    expect(formatElapsed(12_345)).toBe("12 с");
  });

  it("grades seeders", () => {
    expect(seedTone(null)).toBe("none");
    expect(seedTone(0)).toBe("dead");
    expect(seedTone(3)).toBe("low");
    expect(seedTone(5)).toBe("good");
  });

  it("takes the first line of a stack trace", () => {
    const err = "\n  System.Exception: Login failed\n   at Jackett.Common.Indexers.Foo()\n   at Bar()";
    expect(firstLine(err)).toBe("System.Exception: Login failed");
    expect(firstLine(null)).toBe("");
  });

  it("labels categories from CategoryDesc or the main Torznab id", () => {
    expect(categoryLabel(base)).toBe("Other");
    expect(categoryLabel({ CategoryDesc: null, Category: [100003, 2040] })).toBe("Фильмы");
    expect(categoryLabel({ CategoryDesc: null, Category: [100003] })).toBe("");
  });

  it("treats Jackett's year-0001 dates as unknown", () => {
    expect(parseDate("0001-01-01T00:00:00")).toBeNull();
    expect(parseDate(base.PublishDate)).toBe(Date.parse("2026-07-23T00:00:00+03:00"));
  });
});

describe("rows", () => {
  const rows = toRows(fixture.Results);

  it("gives every fixture row a unique id", () => {
    expect(rows).toHaveLength(100);
    expect(new Set(rows.map((r) => r.id)).size).toBe(100);
  });

  it("filters by all words, case-insensitive, with -exclusions", () => {
    const gnome = filterRows(rows, "GNOME");
    expect(gnome.length).toBeGreaterThan(0);
    expect(gnome.every((r) => r.r.Title.toLowerCase().includes("gnome"))).toBe(true);
    const noGnome = filterRows(rows, "ubuntu -gnome");
    expect(noGnome.some((r) => r.r.Title.toLowerCase().includes("gnome"))).toBe(false);
    expect(filterRows(rows, "  ")).toBe(rows);
    expect(filterRows(rows, "rutor other").length).toBe(100); // tracker + category are searchable
    expect(filterRows(rows, "", "kinozal")).toHaveLength(0);
    expect(filterRows(rows, "", "rutor")).toHaveLength(100);
  });

  it("sorts by seeders desc with nulls last and stable ties", () => {
    const extra = toRows([mk({ Title: "A", Seeders: null }), mk({ Title: "B", Seeders: 10 }), mk({ Title: "C", Seeders: 10 }), mk({ Title: "D", Seeders: 0 })]);
    expect(sortRows(extra, "seeders", true).map((r) => r.r.Title)).toEqual(["B", "C", "D", "A"]);
    expect(sortRows(extra, "seeders", false).map((r) => r.r.Title)).toEqual(["D", "B", "C", "A"]);
  });

  it("sorts the fixture by size, date and title", () => {
    const bySize = sortRows(rows, "size", true).map((r) => r.r.Size ?? 0);
    expect(bySize).toEqual([...bySize].sort((a, b) => b - a));
    const byDate = sortRows(rows, "published", true).map((r) => r.published ?? 0);
    expect(byDate).toEqual([...byDate].sort((a, b) => b - a));
    const titles = toRows([mk({ Title: "яблоко" }), mk({ Title: "Apple 10" }), mk({ Title: "apple 9" })]);
    expect(sortRows(titles, "title", false).map((r) => r.r.Title)).toEqual(["яблоко", "apple 9", "Apple 10"]); // ru collation: Cyrillic first, numeric-aware
  });

  it("starts numbers descending and text ascending", () => {
    expect(defaultDesc("seeders")).toBe(true);
    expect(defaultDesc("published")).toBe(true);
    expect(defaultDesc("title")).toBe(false);
  });
});

describe("tracker filter draft", () => {
  const all = ["a", "b", "c"];

  it("opens with everything ticked for 'all' and drops unknown ids", () => {
    expect(draftFromSelection([], all)).toEqual(all);
    expect(draftFromSelection(["gone"], all)).toEqual(all);
    expect(draftFromSelection(["c", "gone", "a"], all)).toEqual(["c", "a"]);
  });

  it("commits nothing or everything as 'all', otherwise ids in list order", () => {
    expect(commitDraft([], all)).toEqual([]);
    expect(commitDraft(["c", "b", "a"], all)).toEqual([]);
    expect(commitDraft(["c", "a", "gone"], all)).toEqual(["a", "c"]);
  });

  it("onlyShown keeps the filtered ids", () => {
    expect(onlyShown([{ id: "b" }, { id: "c" }])).toEqual(["b", "c"]);
  });

  it("splitChips collapses at least two chips into +N", () => {
    expect(splitChips(["a", "b", "c"], 3)).toEqual({ shown: ["a", "b", "c"], hidden: [] });
    expect(splitChips(["a", "b", "c", "d"], 3)).toEqual({ shown: ["a", "b"], hidden: ["c", "d"] });
    expect(splitChips(["a", "b"], 0)).toEqual({ shown: [], hidden: ["a", "b"] });
  });
});
