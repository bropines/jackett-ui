import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ConfigField } from "@/api";
import rutor from "../../../contract/config-rutor.json";
import {
  countByStatus,
  namesPreview,
  needsInput,
  pickSelected,
  pruneSelection,
  toggleId,
  toggleVisible,
  visibleCheckState,
} from "./selection";

const rows = (...ids: string[]) => ids.map((id) => ({ id }));

describe("selection helpers", () => {
  it("toggleId adds and removes", () => {
    expect(toggleId([], "a")).toEqual(["a"]);
    expect(toggleId(["a", "b"], "a")).toEqual(["b"]);
  });

  it("pruneSelection drops missing ids and keeps identity when unchanged", () => {
    const sel = ["a", "b"];
    expect(pruneSelection(sel, rows("a", "b", "c"))).toBe(sel);
    expect(pruneSelection(sel, rows("b"))).toEqual(["b"]);
  });

  it("visibleCheckState reports none / some / all of the visible rows", () => {
    expect(visibleCheckState([], rows())).toBe(false);
    expect(visibleCheckState(["x"], rows("a", "b"))).toBe(false);
    expect(visibleCheckState(["a"], rows("a", "b"))).toBe("indeterminate");
    expect(visibleCheckState(["a", "b", "x"], rows("a", "b"))).toBe(true);
  });

  it("toggleVisible selects every visible row, then clears only those", () => {
    const once = toggleVisible(["x", "a"], rows("a", "b"));
    expect(once).toEqual(["x", "a", "b"]);
    expect(toggleVisible(once, rows("a", "b"))).toEqual(["x"]);
  });

  it("pickSelected keeps list order", () => {
    expect(pickSelected(rows("a", "b", "c"), ["c", "a"]).map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("namesPreview truncates long lists", () => {
    expect(namesPreview(["a", "b"])).toBe("a, b");
    expect(namesPreview(["a", "b", "c", "d"], 2)).toBe("a, b и ещё 2");
  });

  it("countByStatus", () => {
    const c = countByStatus([
      { id: "a", name: "A", status: "added" },
      { id: "b", name: "B", status: "setup" },
      { id: "c", name: "C", status: "setup" },
    ]);
    expect(c.added).toBe(1);
    expect(c.setup).toBe(2);
    expect(c.failed).toBe(0);
  });
});

describe("needsInput", () => {
  const dir = join(process.cwd(), "contract/configs");
  const configs = Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith(".json") && f !== "field-type-examples.json")
      .map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(join(dir, f), "utf8")) as ConfigField[]]),
  );

  it("public trackers with complete defaults can be added as is", () => {
    expect(needsInput(rutor as ConfigField[], "public")).toBe(false);
    for (const id of ["0magnet", "1337x", "thepiratebay", "rutracker-ru", "subsplease", "therarbg", "anilibria"]) {
      expect(needsInput(configs[id] ?? [], "public"), id).toBe(false);
    }
  });

  it("optional uploader / filter fields do not block", () => {
    // 1337x has an empty "Filter by Uploader"; rutracker-ru an empty "Search by Uploader".
    expect(needsInput(configs["1337x"] ?? [])).toBe(false);
    expect(needsInput(configs["rutracker-ru"] ?? [])).toBe(false);
  });

  it("credentials, cookies, api keys and captchas need input", () => {
    for (const id of ["kinozal", "rutracker", "lostfilm", "iptorrents", "redacted", "passthepopcorn", "hdtime", "animebytes"]) {
      expect(needsInput(configs[id] ?? []), id).toBe(true);
    }
  });

  it("every fixture with an empty login or key field is flagged", () => {
    for (const [id, fields] of Object.entries(configs)) {
      const hasEmptyCred = fields.some(
        (f) => f.type === "inputstring" && /^(username|password|cookie|apikey|apitoken|passkey)$/.test(f.id) && !f.value,
      );
      if (hasEmptyCred) expect(needsInput(fields), id).toBe(true);
    }
  });

  it("non-public trackers always go to the config dialog", () => {
    expect(needsInput(configs["0magnet"] ?? [], "private")).toBe(true);
    expect(needsInput(configs["0magnet"] ?? [], "semi-private")).toBe(true);
  });

  it("captcha images, recaptcha, empty passwords and unknown field types need input", () => {
    const site = { id: "sitelink", name: "Site Link", type: "inputstring", value: "https://x/" };
    expect(needsInput([site, { id: "img", name: "Captcha", type: "displayimage", value: "data:image/png;base64,AA" }])).toBe(true);
    expect(needsInput([site, { id: "img", name: "Captcha", type: "displayimage", value: null }])).toBe(false);
    expect(needsInput([site, { id: "r", name: "reCAPTCHA", type: "recaptcha" }])).toBe(true);
    expect(needsInput([site, { id: "p", name: "Password", type: "password", value: "" }])).toBe(true);
    expect(needsInput([site, { id: "x", name: "New", type: "fancywidget" }])).toBe(true);
    expect(needsInput([{ ...site, value: "" }])).toBe(true);
  });
});
