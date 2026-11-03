import { describe, expect, it } from "vitest";

import type { IndexerSummary } from "@/api";
import sample from "../../../contract/indexers.sample.json";
import {
  capRange,
  effectiveStatus,
  EMPTY_FILTER,
  filterCatalog,
  filterConfigured,
  firstLine,
  hostOf,
  indexerCategories,
  isFilterActive,
  languageOptions,
  languageShort,
  matchesCategory,
  matchScore,
  runQueue,
} from "./logic";
import testRutor from "../../../contract/test-rutor.json";

const all = sample as IndexerSummary[];
const byId = (id: string) => {
  const ix = all.find((x) => x.id === id);
  if (!ix) throw new Error(`fixture has no ${id}`);
  return ix;
};
const mk = (over: Partial<IndexerSummary>): IndexerSummary => ({
  id: "x",
  name: "X",
  description: "",
  type: "public",
  configured: false,
  site_link: "https://x.org/",
  alternativesitelinks: [],
  language: "en-US",
  tags: [],
  last_error: "",
  potatoenabled: false,
  caps: [],
  ...over,
});

describe("categories", () => {
  it("maps cap ids to thousand ranges", () => {
    expect(capRange("2040")).toBe(2000);
    expect(capRange(5000)).toBe(5000);
    expect(capRange("100123")).toBeNull();
    expect(capRange("abc")).toBeNull();
    expect(capRange("999")).toBeNull();
  });

  it("matches when any cap is in the range", () => {
    const ix = mk({ caps: [{ ID: "2010", Name: "Movies/Foreign" }, { ID: "100500", Name: "custom" }] });
    expect(matchesCategory(ix, "movies")).toBe(true);
    expect(matchesCategory(ix, "tv")).toBe(false);
    expect(matchesCategory(mk({ caps: [{ ID: "4050", Name: "PC/Games" }] }), "games")).toBe(true);
    expect(matchesCategory(mk({ caps: [{ ID: "1000", Name: "Console" }] }), "games")).toBe(true);
    expect(indexerCategories(mk({ caps: [{ ID: "7000", Name: "Books" }, { ID: "3000", Name: "Audio" }] }))).toEqual(["audio", "books"]);
  });

  it("works on real fixture data", () => {
    const x1337 = byId("1337x");
    expect(matchesCategory(x1337, "movies")).toBe(true);
    expect(matchesCategory(x1337, "games")).toBe(true);
  });
});

describe("languageOptions", () => {
  it("puts ru-RU and en-US first and counts entries", () => {
    const opts = languageOptions(all);
    expect(opts[0]?.code).toBe("ru-RU");
    expect(opts[1]?.code).toBe("en-US");
    const total = opts.reduce((n, o) => n + o.count, 0);
    expect(total).toBe(all.filter((x) => x.language).length);
    expect(new Set(opts.map((o) => o.code)).size).toBe(opts.length);
  });

  it("still orders preferred first when one is missing", () => {
    const opts = languageOptions([mk({ language: "de-DE" }), mk({ language: "en-US" }), mk({ language: "de-DE" })]);
    expect(opts.map((o) => o.code)).toEqual(["en-US", "de-DE"]);
    expect(opts[1]?.count).toBe(2);
  });

  it("short code", () => {
    expect(languageShort("ru-RU")).toBe("RU");
    expect(languageShort("zh-TW")).toBe("ZH");
  });
});

describe("filterCatalog", () => {
  it("returns everything sorted by name without filters", () => {
    const res = filterCatalog(all, EMPTY_FILTER);
    expect(res).toHaveLength(all.length);
    const names = res.map((x) => x.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "ru", { sensitivity: "base" })));
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
  });

  it("filters by type, language and category", () => {
    const res = filterCatalog(all, { ...EMPTY_FILTER, type: "public", language: "ru-RU", category: "movies" });
    expect(res.length).toBeGreaterThan(0);
    for (const ix of res) {
      expect(ix.type).toBe("public");
      expect(ix.language).toBe("ru-RU");
      expect(matchesCategory(ix, "movies")).toBe(true);
    }
  });

  it("searches name, id and description; ranks name hits first", () => {
    const list = [
      mk({ id: "a", name: "Alpha", description: "rutor mirror" }),
      mk({ id: "rutor", name: "RuTor", description: "Russian tracker" }),
      mk({ id: "b", name: "Beta", description: "nothing" }),
    ];
    const res = filterCatalog(list, { ...EMPTY_FILTER, query: "rutor" });
    expect(res.map((x) => x.id)).toEqual(["rutor", "a"]);
    expect(matchScore(list[1]!, "ru")).toBe(1);
    expect(matchScore(list[2]!, "rutor")).toBeNull();
  });

  it("requires every word and ignores case and ё", () => {
    const ix = mk({ name: "Кинозал", description: "Ёмкий русский трекер фильмов" });
    expect(matchScore(ix, "емкий ФИЛЬМОВ")).not.toBeNull();
    expect(matchScore(ix, "емкий музыка")).toBeNull();
  });
});

describe("filterConfigured", () => {
  it("matches tags too", () => {
    const list = [mk({ id: "a", name: "B", tags: ["movies"] }), mk({ id: "b", name: "A" })];
    expect(filterConfigured(list, "").map((x) => x.name)).toEqual(["A", "B"]);
    expect(filterConfigured(list, "mov").map((x) => x.id)).toEqual(["a"]);
  });
});

describe("misc", () => {
  it("firstLine takes the first non-empty line and truncates", () => {
    expect(firstLine("\n  boom \nstack")).toBe("boom");
    expect(firstLine(testRutor.error).startsWith("Exception (rutor)")).toBe(true);
    expect(firstLine("x".repeat(500), 10)).toHaveLength(10);
  });

  it("hostOf", () => {
    expect(hostOf("https://www.rutracker.org/forum/")).toBe("rutracker.org");
    expect(hostOf("not a url")).toBe("not a url");
  });

  it("effectiveStatus prefers the local test result", () => {
    expect(effectiveStatus({ last_error: "" }, undefined)).toEqual({ kind: "ok", tested: false });
    expect(effectiveStatus({ last_error: "bad" }, undefined)).toEqual({ kind: "error", error: "bad", tested: false });
    expect(effectiveStatus({ last_error: "bad" }, { status: "ok", at: 1 })).toEqual({ kind: "ok", tested: true });
    expect(effectiveStatus({ last_error: "" }, { status: "running" })).toEqual({ kind: "running" });
  });
});

describe("runQueue", () => {
  it("respects concurrency, reports progress and collects errors", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const progress: string[] = [];
    const items = [1, 2, 3, 4, 5, 6, 7];
    const res = await runQueue(
      items,
      async (n) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5 + (n % 3) * 3));
        inFlight--;
        if (n % 2 === 0) throw new Error(`fail ${n}`);
      },
      { concurrency: 3, onProgress: (d, t) => progress.push(`${d}/${t}`) },
    );
    expect(maxInFlight).toBe(3);
    expect(res).toHaveLength(7);
    expect(res.filter((r) => !r.ok).map((r) => r.item).sort()).toEqual([2, 4, 6]);
    expect(progress.at(-1)).toBe("7/7");
    expect(progress).toHaveLength(7);
  });

  it("stops picking new items when asked", async () => {
    let started = 0;
    let stop = false;
    const res = await runQueue(
      [1, 2, 3, 4, 5, 6],
      async () => {
        started++;
        if (started === 2) stop = true;
        await Promise.resolve();
      },
      { concurrency: 1, shouldStop: () => stop },
    );
    expect(res).toHaveLength(2);
  });

  it("handles an empty list", async () => {
    expect(await runQueue([], async () => undefined, { concurrency: 3 })).toEqual([]);
  });
});
