import { useQuery } from "@tanstack/react-query";
import { ChevronRight, File, Folder, FolderOpen, ListTree, Loader2, RotateCw } from "lucide-react";
import { useMemo, useState } from "react";

import { errText, qk, serverApi, type SearchResult, type TorrentFiles } from "@/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { formatNumber, plural } from "@/lib/format";
import { cn } from "@/lib/utils";

import { formatSize } from "../logic";
import { buildTree, filesLink, isFlat, type TreeDir, type TreeNode } from "./logic";

/** Rows shown per folder before "show more". */
const STEP = 100;
/** Folders start expanded when the whole torrent has at most this many files. */
const AUTO_EXPAND = 40;

const filesWord = (n: number) => `${formatNumber(n)} ${plural(n, ["файл", "файла", "файлов"])}`;

function Note({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "error" }) {
  return (
    <p className={cn("rounded-md border px-3 py-2.5 text-sm", tone === "error" ? "border-destructive/40 text-destructive" : "bg-muted/40 text-muted-foreground")}>
      {children}
    </p>
  );
}

function SizeCell({ size }: { size: number }) {
  return <span className="shrink-0 pl-2 text-xs tabular-nums text-muted-foreground">{formatSize(size)}</span>;
}

function DirChildren({ nodes, depth, expanded, onToggle }: { nodes: TreeNode[]; depth: number; expanded: Set<string>; onToggle: (p: string) => void }) {
  const [limit, setLimit] = useState(STEP);
  const shown = nodes.slice(0, limit);
  const pad = { paddingLeft: `${depth * 1}rem` };
  return (
    <>
      {shown.map((n) =>
        n.kind === "dir" ? (
          <li key={n.path}>
            <button
              type="button"
              className="flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              style={pad}
              aria-expanded={expanded.has(n.path)}
              onClick={() => onToggle(n.path)}
            >
              <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", expanded.has(n.path) && "rotate-90")} aria-hidden />
              {expanded.has(n.path) ? (
                <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              ) : (
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{n.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatNumber(n.count)}</span>
              <SizeCell size={n.size} />
            </button>
            {expanded.has(n.path) && (
              <ul>
                <DirChildren nodes={n.children} depth={depth + 1} expanded={expanded} onToggle={onToggle} />
              </ul>
            )}
          </li>
        ) : (
          <li key={n.path} className="flex min-w-0 items-start gap-1.5 px-1.5 py-1 text-sm" style={{ paddingLeft: `${depth + (depth > 0 ? 1.25 : 0)}rem` }}>
            <File className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{n.name}</span>
            <SizeCell size={n.size} />
          </li>
        ),
      )}
      {nodes.length > limit && (
        <li style={pad} className="px-1.5 py-1">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setLimit(nodes.length <= limit + STEP * 4 ? nodes.length : limit + STEP)}>
            Показать ещё ({formatNumber(nodes.length - limit)})
          </Button>
        </li>
      )}
    </>
  );
}

/** Tree (or flat list) of the torrent's files. Exported for tests. */
export function FileTree({ data }: { data: TorrentFiles }) {
  const files = useMemo(() => data.files ?? [], [data.files]);
  const tree = useMemo(() => {
    const t = buildTree(files);
    // One top folder holding everything (the torrent's own name): show its contents.
    const only = t.children[0];
    if (t.children.length === 1 && only?.kind === "dir") return only;
    return t;
  }, [files]);
  const total = data.count ?? files.length;
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    total <= AUTO_EXPAND ? new Set(collectDirs(tree)) : new Set(),
  );
  const toggle = (p: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  if (files.length === 0) return <Note>В торренте нет файлов.</Note>;
  const flat = isFlat(tree);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{filesWord(total)}</span>
        <span className="tabular-nums">всего {formatSize(data.totalSize ?? tree.size)}</span>
        {!flat && (
          <span className="ml-auto flex gap-1">
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setExpanded(new Set(collectDirs(tree)))}>
              Развернуть
            </Button>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setExpanded(new Set())}>
              Свернуть
            </Button>
          </span>
        )}
      </div>
      <ul className="max-h-[50vh] overflow-y-auto rounded-md border p-1" aria-label="Файлы">
        <DirChildren nodes={tree.children} depth={0} expanded={expanded} onToggle={toggle} />
      </ul>
      {data.truncated && <p className="text-xs text-muted-foreground">Показаны первые {formatNumber(files.length)} из {filesWord(total)}.</p>}
    </div>
  );
}

function collectDirs(d: TreeDir, out: string[] = []): string[] {
  for (const c of d.children) {
    if (c.kind === "dir") {
      out.push(c.path);
      collectDirs(c, out);
    }
  }
  return out;
}

/**
 * "Файлы" section: downloads the .torrent through the server (`/_ui/api/torrent/files`).
 * Public trackers load at once; private ones wait for a click (a download may count against
 * the tracker's limits).
 */
export function FileList({ r }: { r: SearchResult }) {
  const link = filesLink(r.Link);
  const [requested, setRequested] = useState(r.TrackerType === "public");
  const q = useQuery({
    queryKey: qk.torrentFiles(link ?? ""),
    queryFn: () => serverApi.torrentFiles(link!),
    enabled: !!link && requested,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (!link) return <Note>Список файлов недоступен: у раздачи только magnet-ссылка.</Note>;
  if (!requested)
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
        <span className="min-w-0 flex-1">Чтобы показать файлы, панель скачает .torrent с трекера.</span>
        <Button variant="outline" size="sm" onClick={() => setRequested(true)}>
          <ListTree />
          Показать файлы
        </Button>
      </div>
    );
  if (q.isPending)
    return (
      <div className="space-y-2" aria-busy="true">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Загружаю .torrent…
        </p>
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-6 w-1/2" />
      </div>
    );
  if (q.isError)
    return (
      <div className="space-y-2" role="alert">
        <Note tone="error">{errText(q.error)}</Note>
        <Button variant="outline" size="sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
          <RotateCw className={cn(q.isFetching && "animate-spin")} />
          Повторить
        </Button>
      </div>
    );
  if (q.data.magnet) return <Note>Список файлов недоступен: у раздачи только magnet-ссылка.</Note>;
  return <FileTree data={q.data} />;
}
