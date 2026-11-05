/**
 * Pure mapping between Jackett's indexer config field list and the form state.
 *
 * Form state is an array aligned with the field list by index (ids can be "" or
 * repeat, so they are not usable as keys). Each slot holds the editable value:
 * `value` for most types, `values` for `inputcheckbox`, `undefined` for read-only
 * types. `toFields` writes the state back into a copy of the list, touching only
 * `value`/`values` of fields that actually changed, so an untouched form posts
 * back exactly what the server sent.
 */
import type { ConfigField, InputTagsField } from "@/api/types";

export type FieldValue = string | boolean | (string | null)[] | null | undefined;
export type FormState = FieldValue[];

/** Field types the form edits. Everything else is display-only and sent back unchanged. */
const EDITABLE = new Set(["inputstring", "password", "hiddendata", "inputbool", "inputselect", "inputcheckbox", "inputtags"]);

/** A field as it may arrive from a newer Jackett (unknown `type`). */
type AnyField = ConfigField | { id: string; name: string; type: string; [k: string]: unknown };

export function isEditable(field: AnyField): boolean {
  return EDITABLE.has(field.type);
}

export function toFormState(fields: readonly AnyField[]): FormState {
  return fields.map((f) => {
    if (!isEditable(f)) return undefined;
    if (f.type === "inputcheckbox") {
      const values = (f as { values?: unknown }).values;
      return Array.isArray(values) ? [...(values as (string | null)[])] : [];
    }
    return (f as { value?: FieldValue }).value;
  });
}

export function valuesEqual(a: FieldValue, b: FieldValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/** Builds the full field list to POST: same order, same objects, only value/values replaced where edited. */
export function toFields<T extends AnyField>(fields: readonly T[], state: FormState): T[] {
  return fields.map((f, i) => {
    if (!isEditable(f)) return { ...f };
    const next = state[i];
    if (f.type === "inputcheckbox") {
      const orig = (f as { values?: FieldValue }).values;
      if (valuesEqual(orig, next)) return { ...f };
      return { ...f, values: Array.isArray(next) ? next.filter((v): v is string => v !== null) : [] };
    }
    const orig = (f as { value?: FieldValue }).value;
    if (valuesEqual(orig, next)) return { ...f };
    return { ...f, value: next };
  });
}

export function isDirty(initial: FormState, state: FormState): boolean {
  if (initial.length !== state.length) return true;
  return initial.some((v, i) => !valuesEqual(v, state[i]));
}

/* ── Field classification ───────────────────────────────────────────────── */

const SECRET_RE = /pass|passkey|apikey|api ?key|cookie|token|(^|[^a-z])pid([^a-z]|$)|rss ?key|secret/i;

/** Plain `inputstring` fields that hold credentials and should be masked. */
export function isSecretField(field: Pick<AnyField, "id" | "name" | "type">): boolean {
  if (field.type === "password") return true;
  if (field.type !== "inputstring") return false;
  return SECRET_RE.test(field.id) || SECRET_RE.test(field.name);
}

export function isSiteLinkField(field: Pick<AnyField, "id" | "type">): boolean {
  return field.type === "inputstring" && field.id === "sitelink";
}

export function isCaptchaTextField(field: Pick<AnyField, "id" | "type">): boolean {
  return field.type === "inputstring" && /captcha/i.test(field.id);
}

/** `displayinfo` rows with neither name nor value are spacers. */
export function isSpacer(field: AnyField): boolean {
  if (field.type !== "displayinfo") return false;
  const { name, value } = field as { name?: string; value?: unknown };
  return !name && !value;
}

/** Whether a `displayinfo` row should show its name as a heading. */
export function infoHeading(field: { name?: string | null; value?: unknown }): string | null {
  const name = (field.name ?? "").trim();
  if (!name) return null;
  if (typeof field.value === "string" && field.value.trim() === name) return null;
  return name;
}

/* ── Tags ───────────────────────────────────────────────────────────────── */

function safeRegExp(source: string | undefined, flags = ""): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/** Tags currently stored in the field value. */
export function parseTags(value: string | null | undefined, field: Pick<InputTagsField, "separator">): string[] {
  if (!value) return [];
  const sep = field.separator || ",";
  return value
    .split(sep)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function joinTags(tags: readonly string[], field: Pick<InputTagsField, "separator">): string {
  return tags.join(field.separator || ",");
}

export function isValidTag(tag: string, field: Pick<InputTagsField, "pattern">): boolean {
  const re = safeRegExp(field.pattern);
  return re ? re.test(tag) : tag.length > 0;
}

/** Splits typed text into tags on the field's `delimiters` regex and checks each against `pattern`. */
export function splitTags(
  text: string,
  field: Pick<InputTagsField, "delimiters" | "pattern" | "separator">,
): { valid: string[]; invalid: string[] } {
  const delim = safeRegExp(field.delimiters) ?? new RegExp(`[${escapeForClass(field.separator || ",")}\\s]+`);
  const parts = text
    .split(delim)
    .map((t) => t.trim())
    .filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) (isValidTag(p, field) ? valid : invalid).push(p);
  return { valid, invalid };
}

function escapeForClass(s: string): string {
  return s.replace(/[\\\]^-]/g, "\\$&");
}

/** Adds tags to a stored value, skipping duplicates. */
export function addTags(value: string | null | undefined, tags: readonly string[], field: Pick<InputTagsField, "separator">): string {
  const cur = parseTags(value, field);
  for (const t of tags) if (!cur.includes(t)) cur.push(t);
  return joinTags(cur, field);
}

export function removeTag(value: string | null | undefined, tag: string, field: Pick<InputTagsField, "separator">): string {
  return joinTags(
    parseTags(value, field).filter((t) => t !== tag),
    field,
  );
}

/* ── Checkbox groups ────────────────────────────────────────────────────── */

export function toggleValue(values: FieldValue, key: string, checked: boolean): string[] {
  const cur = Array.isArray(values) ? values.filter((v): v is string => v !== null) : [];
  if (checked) return cur.includes(key) ? cur : [...cur, key];
  return cur.filter((v) => v !== key);
}

/* ── Refetch merge ──────────────────────────────────────────────────────── */

/**
 * After the config is re-fetched (new captcha), carry the user's input over to
 * the new field list. Fields are matched by id + type; captcha text is reset
 * because it belongs to the old image. Unmatched fields take the server value.
 */
export function mergeFormState(
  prevFields: readonly AnyField[],
  prevState: FormState,
  nextFields: readonly AnyField[],
): FormState {
  const next = toFormState(nextFields);
  const byKey = new Map<string, FieldValue>();
  prevFields.forEach((f, i) => {
    if (f.id && isEditable(f)) byKey.set(`${f.type}\u0000${f.id}`, prevState[i]);
  });
  return nextFields.map((f, i) => {
    if (!f.id || !isEditable(f) || isCaptchaTextField(f) || f.type === "hiddendata") return next[i];
    const key = `${f.type}\u0000${f.id}`;
    return byKey.has(key) ? byKey.get(key) : next[i];
  });
}

/* ── Save errors ────────────────────────────────────────────────────────── */

export interface SaveErrorInfo {
  message: string;
  /** Russian explanation shown under the raw message, if we recognise the error. */
  hint: string | null;
  /** The captcha should be re-fetched. */
  captcha: boolean;
}

export function describeSaveError(message: string): SaveErrorInfo {
  let hint: string | null = null;
  if (/flaresolverr/i.test(message)) {
    hint =
      "Сайт показал проверку Cloudflare, а пройти её Jackett может только через FlareSolverr. Попробуйте другое зеркало в поле адреса сайта, если оно есть, или укажите адрес FlareSolverr в Настройки → Jackett и сохраните трекер ещё раз.";
  }
  const captcha = /captcha|капч/i.test(message);
  if (captcha && !hint) hint = "Введите текст с новой картинки и сохраните ещё раз.";
  return { message, hint, captcha };
}
