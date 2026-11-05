/** Pure helpers for multi-select on the Indexers page and in the catalog (unit-tested). */
import type { ConfigField, IndexerType } from "@/api";

/* ── Selection ──────────────────────────────────────────────────────────── */

export function toggleId(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
}

/** Keeps only ids that still exist (e.g. after a delete or refetch). Returns the same array when nothing changed. */
export function pruneSelection(selected: string[], existing: readonly { id: string }[]): string[] {
  const ids = new Set(existing.map((x) => x.id));
  const next = selected.filter((id) => ids.has(id));
  return next.length === selected.length ? selected : next;
}

export type CheckState = boolean | "indeterminate";

/** Header checkbox state for the visible rows. */
export function visibleCheckState(selected: readonly string[], visible: readonly { id: string }[]): CheckState {
  if (visible.length === 0) return false;
  const n = visible.filter((x) => selected.includes(x.id)).length;
  if (n === 0) return false;
  return n === visible.length ? true : "indeterminate";
}

/** Header checkbox click: all visible selected → unselect them, otherwise add every visible row. Hidden selections stay. */
export function toggleVisible(selected: readonly string[], visible: readonly { id: string }[]): string[] {
  if (visibleCheckState(selected, visible) === true) {
    const vis = new Set(visible.map((x) => x.id));
    return selected.filter((id) => !vis.has(id));
  }
  const out = [...selected];
  for (const x of visible) if (!out.includes(x.id)) out.push(x.id);
  return out;
}

/** Items of `list` whose id is selected, in list order (one per id). */
export function pickSelected<T extends { id: string }>(list: readonly T[], selected: readonly string[]): T[] {
  const want = new Set(selected);
  return list.filter((x) => want.delete(x.id));
}

/** "a, b, c и ещё 4" for confirm dialogs. */
export function namesPreview(names: readonly string[], max = 8): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} и ещё ${names.length - max}`;
}

/* ── "Needs user input" for quick add ───────────────────────────────────── */

/** Empty text fields that are optional filters, not credentials ("Filter by Uploader", "Filters (optional)"). */
const OPTIONAL_TEXT_RE = /uploader|optional/i;

const KNOWN_TYPES = new Set<string>([
  "inputstring",
  "password",
  "hiddendata",
  "inputbool",
  "inputselect",
  "inputcheckbox",
  "inputtags",
  "displayinfo",
  "displayimage",
  "recaptcha",
] satisfies ConfigField["type"][]);

/** A config field as it may arrive (also from a newer Jackett with unknown types). */
type LooseField = { id: string; name?: string | null; type: string; value?: unknown };

/**
 * Whether a tracker's default config can be saved as is (adding it) or the user must fill something in.
 * Conservative: anything that is not clearly public and complete goes to the config dialog.
 *
 * Needs input when:
 * - the tracker is not public (private / semi-private trackers need an account);
 * - the config shows a captcha (`displayimage` with a value, or a `recaptcha` field) or has an unknown field type;
 * - any `password` field is empty;
 * - any `inputstring` other than the site link is empty, unless it is an optional filter (uploader / "optional").
 */
export function needsInput(fields: readonly LooseField[], type?: IndexerType): boolean {
  if (type && type !== "public") return true;
  for (const f of fields) {
    if (!KNOWN_TYPES.has(f.type) || f.type === "recaptcha") return true;
    const value = f.value;
    const empty = value === undefined || value === null || (typeof value === "string" && value.trim() === "");
    if (f.type === "displayimage" && !empty) return true;
    if (f.type === "password" && empty) return true;
    if (f.type === "inputstring" && empty) {
      if (f.id === "sitelink") return true; // no site link at all: let the user see it
      if (OPTIONAL_TEXT_RE.test(f.id) || OPTIONAL_TEXT_RE.test(f.name ?? "")) continue;
      return true;
    }
  }
  return false;
}

/* ── Bulk add results ───────────────────────────────────────────────────── */

export type AddStatus = "pending" | "running" | "added" | "failed" | "setup" | "skipped";

export interface AddItem {
  id: string;
  name: string;
  status: AddStatus;
  error?: string;
}

export function countByStatus(items: readonly AddItem[]): Record<AddStatus, number> {
  const out: Record<AddStatus, number> = { pending: 0, running: 0, added: 0, failed: 0, setup: 0, skipped: 0 };
  for (const it of items) out[it.status]++;
  return out;
}
