/**
 * Saved tracker groups for the search filter. Stored per browser in localStorage
 * (never trusted: parsed defensively, every access wrapped in try/catch).
 */

export interface TrackerPreset {
  id: string;
  name: string;
  trackers: string[];
}

export const PRESETS_KEY = "jackett-ui:search-tracker-presets";
const MAX_NAME = 60;

/** Validates whatever was stored; drops broken entries. */
export function parsePresets(raw: string | null | undefined): TrackerPreset[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: TrackerPreset[] = [];
  for (const p of data) {
    if (!p || typeof p !== "object") continue;
    const { id, name, trackers } = p as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string" || !Array.isArray(trackers)) continue;
    const ids = [...new Set(trackers.filter((t): t is string => typeof t === "string" && t !== ""))];
    if (!name.trim() || ids.length === 0) continue;
    out.push({ id, name: name.trim().slice(0, MAX_NAME), trackers: ids });
  }
  return out;
}

export function loadPresets(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): TrackerPreset[] {
  try {
    return parsePresets(storage?.getItem(PRESETS_KEY));
  } catch {
    return [];
  }
}

/** Returns false when the browser refused to store (private mode, quota). */
export function savePresets(presets: readonly TrackerPreset[], storage: Pick<Storage, "setItem"> | undefined = safeStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(PRESETS_KEY, JSON.stringify(presets));
    return true;
  } catch {
    return false;
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** Adds a preset; a preset with the same name (case-insensitive) is replaced in place. */
export function upsertPreset(list: readonly TrackerPreset[], name: string, trackers: readonly string[], id = newId()): TrackerPreset[] {
  const clean = name.trim().slice(0, MAX_NAME);
  const ids = [...new Set(trackers)];
  if (!clean || ids.length === 0) return [...list];
  const i = list.findIndex((p) => p.name.toLowerCase() === clean.toLowerCase());
  if (i >= 0) return list.map((p, j) => (j === i ? { ...p, name: clean, trackers: ids } : p));
  return [...list, { id, name: clean, trackers: ids }];
}

export function removePreset(list: readonly TrackerPreset[], id: string): TrackerPreset[] {
  return list.filter((p) => p.id !== id);
}

/** Preset trackers that are still configured (a deleted tracker silently drops out). */
export function applicableTrackers(preset: TrackerPreset, configured: readonly string[]): string[] {
  const set = new Set(configured);
  return preset.trackers.filter((id) => set.has(id));
}

/** Whether the current selection equals the preset (order-independent; ignores unconfigured ids). */
export function presetMatches(preset: TrackerPreset, selected: readonly string[], configured: readonly string[]): boolean {
  const ids = applicableTrackers(preset, configured);
  return ids.length > 0 && ids.length === selected.length && ids.every((id) => selected.includes(id));
}

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
