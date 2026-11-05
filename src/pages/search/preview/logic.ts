import { localizeLink } from "@/api";

/** Poster URL safe to put in <img src> (http/https only), else null. */
export function posterUrl(poster: string | null | undefined): string | null {
  if (!poster) return null;
  try {
    const u = new URL(poster.trim(), window.location.origin);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The `link` for `GET /_ui/api/torrent/files`: the localized result Link as a same-origin
 * `/dl/…` path + query, or null when the result has no such link (magnet-only).
 */
export function filesLink(link: string | null | undefined): string | null {
  const local = localizeLink(link);
  if (!local) return null;
  try {
    const u = new URL(local, window.location.origin);
    if (u.origin !== window.location.origin || !u.pathname.startsWith("/dl/")) return null;
    return u.pathname + u.search;
  } catch {
    return null;
  }
}

export function imdbUrl(id: number | null | undefined): string | null {
  if (!id || id <= 0) return null;
  return `https://www.imdb.com/title/tt${String(id).padStart(7, "0")}/`;
}

/** TMDb page: TV for 5000-range categories, movie otherwise. */
export function tmdbUrl(id: number | null | undefined, categories: readonly number[] = []): string | null {
  if (!id || id <= 0) return null;
  const tv = categories.some((c) => c >= 5000 && c < 6000);
  return `https://www.themoviedb.org/${tv ? "tv" : "movie"}/${id}`;
}

const HTML_TAG = /<\/?[a-z][a-z0-9]*(\s[^>]*)?\/?>/i;
/** HTML with its own line structure (newlines in it are just source formatting). */
const BLOCK_TAG = /<(br|p|div|li|ul|ol|table|tr|h[1-6])\b/i;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Description as HTML for SafeHtml (which sanitizes it): HTML is passed through, plain text is
 * escaped with line breaks kept. Null when empty or just a copy of the title (RuTor does that).
 */
export function descriptionHtml(desc: string | null | undefined, title?: string): string | null {
  const d = desc?.trim();
  if (!d) return null;
  if (title && d.replace(/\s+/g, " ") === title.trim().replace(/\s+/g, " ")) return null;
  if (HTML_TAG.test(d)) return BLOCK_TAG.test(d) ? d : d.replace(/\r?\n/g, "<br>");
  return escapeHtml(d).replace(/\r?\n/g, "<br>");
}

/* ── File tree ─────────────────────────────────────────────────────────── */

export interface TreeFile {
  kind: "file";
  name: string;
  path: string;
  size: number;
}

export interface TreeDir {
  kind: "dir";
  name: string;
  path: string;
  size: number;
  count: number;
  children: TreeNode[];
}

export type TreeNode = TreeFile | TreeDir;

/**
 * Builds a folder tree from flat torrent paths ("a/b/c.mkv"). Folders come first, then files,
 * each sorted by name; folder sizes and file counts are totals. A single top folder that holds
 * everything (the torrent's own name) is unwrapped by the caller if wanted.
 */
export function buildTree(files: readonly { path: string; size: number }[]): TreeDir {
  const root: TreeDir = { kind: "dir", name: "", path: "", size: 0, count: 0, children: [] };
  const dirs = new Map<string, TreeDir>([["", root]]);
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    if (parts.length === 0) parts.push("—");
    const size = Number.isFinite(f.size) && f.size > 0 ? f.size : 0;
    let parent = root;
    let prefix = "";
    root.size += size;
    root.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]!;
      let d = dirs.get(prefix);
      if (!d) {
        d = { kind: "dir", name: parts[i]!, path: prefix, size: 0, count: 0, children: [] };
        dirs.set(prefix, d);
        parent.children.push(d);
      }
      d.size += size;
      d.count++;
      parent = d;
    }
    const name = parts[parts.length - 1]!;
    parent.children.push({ kind: "file", name, path: prefix ? `${prefix}/${name}` : name, size });
  }
  const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });
  const sort = (d: TreeDir) => {
    d.children.sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === "dir" ? -1 : 1));
    for (const c of d.children) if (c.kind === "dir") sort(c);
  };
  sort(root);
  return root;
}

/** True when every file sits at the top level (show a flat list). */
export function isFlat(tree: TreeDir): boolean {
  return tree.children.every((c) => c.kind === "file");
}
