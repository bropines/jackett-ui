import { describe, expect, it } from "vitest";

import { definitionProblems, definitionTemplate, topLevel, validDefinitionId } from "./logic";

describe("definitions logic", () => {
  it("validates ids like the server", () => {
    expect(validDefinitionId("rutor-mirror")).toBe(true);
    expect(validDefinitionId("a.b_c-1")).toBe(true);
    expect(validDefinitionId("Rutor")).toBe(false);
    expect(validDefinitionId("-x")).toBe(false);
    expect(validDefinitionId("a b")).toBe(false);
    expect(validDefinitionId("x".repeat(65))).toBe(false);
  });

  it("reads top-level keys only", () => {
    const y = "# c\n---\nid: 'abc'\n  name: nested\nname: \"Abc Tracker\" # note\nlinks:\n  - a\n";
    expect(topLevel(y, "id")).toBe("abc");
    expect(topLevel(y, "name")).toBe("Abc Tracker");
    expect(topLevel(y, "links")).toBe("");
    expect(topLevel(y, "search")).toBeNull();
  });

  it("template passes the checks for its id", () => {
    expect(definitionProblems("my-tracker", definitionTemplate("my-tracker"))).toEqual([]);
  });

  it("reports a mismatched id and missing sections", () => {
    const p = definitionProblems("other", "id: mine\n");
    expect(p).toHaveLength(3);
    expect(p[0]).toContain("mine");
  });
});
