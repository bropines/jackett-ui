import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ConfigField, InputTagsField } from "@/api/types";

import {
  addTags,
  describeSaveError,
  infoHeading,
  isDirty,
  isSecretField,
  isSpacer,
  mergeFormState,
  parseTags,
  removeTag,
  splitTags,
  toFields,
  toFormState,
  toggleValue,
  type FieldValue,
} from "./fields";

const CONTRACT = join(process.cwd(), "contract");
const configDir = join(CONTRACT, "configs");
const configs: [string, ConfigField[]][] = readdirSync(configDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(join(configDir, f), "utf8")) as ConfigField[]]);
const extra = ["config-rutracker.json", "config-kinozal.json", "config-rutor.json", "config-rutor-after.json"]
  .map((f): [string, ConfigField[]] => [f, JSON.parse(readFileSync(join(CONTRACT, f), "utf8")) as ConfigField[]]);
const all = [...configs, ...extra];

const tagsField: InputTagsField = {
  id: "tags",
  type: "inputtags",
  name: "Tags",
  value: "",
  separator: ",",
  delimiters: "[^A-Za-z0-9\\-\\._~]+",
  pattern: "^[A-Za-z0-9\\-\\._~]+$",
};

/** A plausible edit for every editable field type. */
function edit(f: ConfigField, cur: FieldValue): FieldValue {
  switch (f.type) {
    case "inputstring":
    case "password":
      return `${cur ?? ""}x`;
    case "inputbool":
      return !cur;
    case "inputselect": {
      const keys = Object.keys(f.options);
      return keys.find((k) => k !== cur) ?? cur;
    }
    case "inputcheckbox": {
      const k = Object.keys(f.options)[0];
      if (k === undefined) return cur;
      return toggleValue(cur, k, !(Array.isArray(cur) && cur.includes(k)));
    }
    case "inputtags":
      return addTags(cur as string, ["newtag"], f);
    default:
      return cur;
  }
}

describe("fixtures", () => {
  it("loads ~80 configs", () => {
    expect(configs.length).toBeGreaterThan(70);
  });
});

describe.each(all)("%s", (_name, fields) => {
  it("round-trips untouched state to an identical list", () => {
    const out = toFields(fields, toFormState(fields));
    expect(out).toStrictEqual(fields);
    expect(JSON.stringify(out)).toBe(JSON.stringify(fields));
  });

  it("does not mutate the input", () => {
    const copy = structuredClone(fields);
    const state = toFormState(fields);
    fields.forEach((f, i) => (state[i] = edit(f, state[i])));
    toFields(fields, state);
    expect(fields).toStrictEqual(copy);
  });

  it("edits change only value/values, order and other keys preserved", () => {
    const state = toFormState(fields);
    fields.forEach((f, i) => (state[i] = edit(f, state[i])));
    const out = toFields(fields, state);
    expect(out).toHaveLength(fields.length);
    out.forEach((o, i) => {
      const f = fields[i]!;
      expect(o.id).toBe(f.id);
      expect(o.type).toBe(f.type);
      expect(Object.keys(o).sort()).toEqual(Object.keys(f).sort());
      const strip = (x: object) => {
        const { value: _v, values: _vs, ...rest } = x as Record<string, unknown>;
        return rest;
      };
      expect(strip(o)).toStrictEqual(strip(f));
      if (f.type === "inputcheckbox") expect((o as typeof f).values.every((v) => typeof v === "string")).toBe(true);
    });
    const editable = fields.some((f) => ["inputstring", "password", "inputbool", "inputtags"].includes(f.type));
    expect(isDirty(toFormState(fields), state)).toBe(editable);
  });

  it("is not dirty initially", () => {
    expect(isDirty(toFormState(fields), toFormState(fields))).toBe(false);
  });

  it("keeps read-only rows (displayinfo/displayimage/empty id) in place", () => {
    const out = toFields(fields, toFormState(fields).map(() => "garbage"));
    out.forEach((o, i) => {
      if (["displayinfo", "displayimage", "recaptcha"].includes(fields[i]!.type)) expect(o).toStrictEqual(fields[i]);
    });
  });
});

describe("toFields specifics", () => {
  const fields: ConfigField[] = [
    { id: "", type: "displayinfo", name: "", value: null },
    { id: "username", type: "inputstring", name: "Username", value: null },
    { id: "codec", type: "inputcheckbox", name: "Codec", values: [null as unknown as string], options: { "1": "H.264", "2": "x265" } },
    { id: "unknownthing", type: "fancything", name: "Fancy", value: { a: 1 } } as unknown as ConfigField,
  ];

  it("keeps null when untouched, sends string once edited", () => {
    const s = toFormState(fields);
    expect(toFields(fields, s)[1]).toStrictEqual(fields[1]);
    s[1] = "bob";
    expect(toFields(fields, s)[1]).toStrictEqual({ ...fields[1], value: "bob" });
  });

  it("drops null placeholders from checkbox values once edited", () => {
    const s = toFormState(fields);
    expect(toFields(fields, s)[2]).toStrictEqual(fields[2]);
    s[2] = toggleValue(s[2], "2", true);
    expect(toFields(fields, s)[2]).toMatchObject({ values: ["2"] });
  });

  it("passes unknown types through unchanged", () => {
    const s = toFormState(fields);
    expect(s[3]).toBeUndefined();
    expect(toFields(fields, s)[3]).toStrictEqual(fields[3]);
  });
});

describe("isSecretField", () => {
  const f = (id: string, name = id, type: ConfigField["type"] = "inputstring") => ({ id, name, type });
  it.each([
    ["password", "Password"],
    ["passkey", "Passkey"],
    ["apikey", "APIKey"],
    ["apikey", "API Key"],
    ["cookie", "Cookie"],
    ["apitoken", "API Token"],
    ["csrftoken", "CSRF Token"],
    ["pid", "PID"],
    ["rsskey", "RSS Key"],
    ["clientsecret", "Client Secret"],
  ])("masks %s / %s", (id, name) => expect(isSecretField(f(id, name))).toBe(true));

  it.each([
    ["username", "Username"],
    ["sitelink", "Site Link"],
    ["captchatext", "Captcha Text"],
    ["rapidsearch", "Rapid search"],
    ["searchbyuploader", "Search By Uploader"],
  ])("does not mask %s", (id, name) => expect(isSecretField(f(id, name))).toBe(false));

  it("only applies to text inputs, always to password type", () => {
    expect(isSecretField(f("password", "Password", "inputbool"))).toBe(false);
    expect(isSecretField(f("x", "X", "password"))).toBe(true);
  });

  it("masks every credential-looking field in the fixtures", () => {
    for (const [, fields] of configs)
      for (const fl of fields)
        if (fl.type === "inputstring" && /^(password|passkey|apikey|cookie|apitoken)$/.test(fl.id)) expect(isSecretField(fl)).toBe(true);
  });
});

describe("tags", () => {
  it("splits on the delimiters regex and validates against pattern", () => {
    expect(splitTags("foo, bar baz;;qux", tagsField)).toEqual({ valid: ["foo", "bar", "baz", "qux"], invalid: [] });
    expect(splitTags("  ", tagsField)).toEqual({ valid: [], invalid: [] });
  });

  it("reports tags that fail the pattern", () => {
    const strict = { ...tagsField, delimiters: "[,\\s]+", pattern: "^[a-z]+$" };
    expect(splitTags("ok,BAD,fine x1", strict)).toEqual({ valid: ["ok", "fine"], invalid: ["BAD", "x1"] });
  });

  it("survives broken regexes", () => {
    const broken = { ...tagsField, delimiters: "[", pattern: "(" };
    expect(splitTags("a,b c", broken)).toEqual({ valid: ["a", "b", "c"], invalid: [] });
  });

  it("parses, adds (deduped) and removes with the separator", () => {
    expect(parseTags("", tagsField)).toEqual([]);
    expect(parseTags(null, tagsField)).toEqual([]);
    expect(parseTags("a,b,,c", tagsField)).toEqual(["a", "b", "c"]);
    expect(addTags("a,b", ["b", "c"], tagsField)).toBe("a,b,c");
    expect(addTags("", ["x"], tagsField)).toBe("x");
    expect(removeTag("a,b,c", "b", tagsField)).toBe("a,c");
    expect(addTags("a", ["b"], { separator: ";" })).toBe("a;b");
  });
});

describe("toggleValue", () => {
  it("adds and removes keys", () => {
    expect(toggleValue([], "a", true)).toEqual(["a"]);
    expect(toggleValue(["a"], "a", true)).toEqual(["a"]);
    expect(toggleValue(["a", "b"], "a", false)).toEqual(["b"]);
    expect(toggleValue([null], "a", true)).toEqual(["a"]);
    expect(toggleValue(undefined, "a", true)).toEqual(["a"]);
  });
});

describe("displayinfo helpers", () => {
  it("detects spacers", () => {
    expect(isSpacer({ id: "", type: "displayinfo", name: "", value: null })).toBe(true);
    expect(isSpacer({ id: "", type: "displayinfo", name: "", value: "" })).toBe(true);
    expect(isSpacer({ id: "x", type: "displayinfo", name: "Info", value: "text" })).toBe(false);
    expect(isSpacer({ id: "", type: "inputstring", name: "", value: null })).toBe(false);
  });

  it("shows a heading only when it differs from the value", () => {
    expect(infoHeading({ name: "Captcha Info", value: "<b>x</b>" })).toBe("Captcha Info");
    expect(infoHeading({ name: "Same", value: "Same" })).toBeNull();
    expect(infoHeading({ name: "", value: "x" })).toBeNull();
  });
});

describe("mergeFormState", () => {
  const prev: ConfigField[] = [
    { id: "username", type: "inputstring", name: "Username", value: null },
    { id: "password", type: "inputstring", name: "Password", value: "" },
    { id: "captchaimage", type: "displayimage", name: "Captcha Image", value: "data:image/png;base64,AAA" },
    { id: "captchatext", type: "inputstring", name: "Captcha Text", value: null },
    { id: "magnet", type: "inputbool", name: "Magnet", value: false },
  ];
  const next: ConfigField[] = [
    ...prev.slice(0, 2),
    { id: "captchaimage", type: "displayimage", name: "Captcha Image", value: "data:image/png;base64,BBB" },
    { id: "captchatext", type: "inputstring", name: "Captcha Text", value: null },
    { id: "magnet", type: "inputbool", name: "Magnet", value: false },
    { id: "newone", type: "inputstring", name: "New", value: "srv" },
  ];

  it("keeps user input, resets captcha text, takes server values for new fields", () => {
    const state = toFormState(prev);
    state[0] = "bob";
    state[1] = "secret";
    state[3] = "abcd";
    state[4] = true;
    const merged = mergeFormState(prev, state, next);
    expect(merged).toEqual(["bob", "secret", undefined, null, true, "srv"]);
    const out = toFields(next, merged);
    expect(out[2]).toStrictEqual(next[2]);
    expect(out[0]).toMatchObject({ value: "bob" });
  });
});

describe("describeSaveError", () => {
  it("explains FlareSolverr", () => {
    const e = describeSaveError("Challenge detected but FlareSolverr is not configured");
    expect(e.hint).toMatch(/Cloudflare/);
    expect(e.captcha).toBe(false);
  });
  it("flags captcha errors", () => {
    const e = describeSaveError("Login failed: wrong captcha");
    expect(e.captcha).toBe(true);
    expect(e.hint).toBeTruthy();
  });
  it("passes other errors through", () => {
    expect(describeSaveError("Incorrect password")).toEqual({ message: "Incorrect password", hint: null, captcha: false });
  });
});
