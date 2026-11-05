import { Download, ExternalLink, Magnet } from "lucide-react";
import { useState } from "react";

import { localizeLink, type SearchResult } from "@/api";
import { CopyButton } from "@/components/common";
import { SafeHtml } from "@/components/safe-html";
import { buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatDateTime, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

import { formatSize, SEED_TONE_CLASS, seedTone, type ResultRow } from "../logic";
import { useMediaQuery } from "../useMediaQuery";
import { FileList } from "./FileList";
import { descriptionHtml, imdbUrl, posterUrl, tmdbUrl } from "./logic";
import { Poster } from "./Poster";

const LONG_DESCRIPTION = 700;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function ActionLink({ href, newTab, children }: { href: string; newTab?: boolean; children: React.ReactNode }) {
  return (
    <a href={href} className={buttonVariants({ variant: "outline", size: "sm" })} {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      {children}
    </a>
  );
}

function Description({ html }: { html: string }) {
  const long = html.length > LONG_DESCRIPTION;
  const [open, setOpen] = useState(!long);
  return (
    <div>
      <div className={cn("relative", !open && "max-h-48 overflow-hidden")}>
        <SafeHtml html={html} className="break-words text-foreground/90 [overflow-wrap:anywhere]" />
        {!open && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background" aria-hidden />}
      </div>
      {long && (
        <button type="button" className="mt-1 text-sm text-primary underline-offset-4 hover:underline" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Свернуть" : "Показать полностью"}
        </button>
      )}
    </div>
  );
}

function Facts({ r, category }: { r: SearchResult; category: string }) {
  const published = r.PublishDate && !r.PublishDate.startsWith("0001-") ? formatDateTime(r.PublishDate) : null;
  const items: [string, React.ReactNode][] = [
    ["Размер", <span className="tabular-nums">{formatSize(r.Size)}</span>],
    [
      "Сиды / пиры",
      <span className="tabular-nums">
        <span className={cn("font-medium", SEED_TONE_CLASS[seedTone(r.Seeders)])}>{r.Seeders ?? "—"}</span>
        <span className="text-muted-foreground"> / {r.Peers ?? "—"}</span>
      </span>,
    ],
    ["Дата", published ?? "—"],
    ["Трекер", r.Tracker],
  ];
  if (category) items.push(["Категория", category]);
  if (r.Files != null) items.push(["Файлов", formatNumber(r.Files)]);
  if (r.Grabs != null) items.push(["Скачиваний", formatNumber(r.Grabs)]);
  if (r.Year) items.push(["Год", String(r.Year)]);
  if (r.Genres?.length) items.push(["Жанры", r.Genres.join(", ")]);
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Preview of one result: right-side panel on desktop, full screen on mobile. */
export function ResultPreview({ row, open, onOpenChange }: { row: ResultRow | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const desktop = useMediaQuery("(min-width: 768px)");
  return (
    <Sheet open={open && !!row} onOpenChange={onOpenChange}>
      {row && (
        <SheetContent side={desktop ? "right" : "full"}>
          <PreviewBody key={row.id} row={row} />
        </SheetContent>
      )}
    </Sheet>
  );
}

function PreviewBody({ row }: { row: ResultRow }) {
  const r = row.r;
  const torrent = localizeLink(r.Link);
  const imdb = imdbUrl(r.Imdb);
  const tmdb = tmdbUrl(r.TMDb, r.Category);
  const desc = descriptionHtml(r.Description, r.Title);
  const hasPoster = !!posterUrl(r.Poster);
  return (
    <>
      <SheetHeader className="border-b px-4 py-3 sm:px-5">
        <SheetTitle className="break-words [overflow-wrap:anywhere]">{r.Title}</SheetTitle>
        <SheetDescription className="text-xs">
          {r.Tracker}
          {row.category && ` · ${row.category}`}
        </SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-5">
        <div className="flex gap-4">
          {hasPoster && <Poster src={r.Poster} alt={`Постер: ${r.Title}`} className="h-44 w-[7.5rem] sm:h-56 sm:w-[9.5rem]" iconClassName="h-6 w-6" />}
          <div className="min-w-0 flex-1">
            <Facts r={r} category={row.category} />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {torrent && (
            <ActionLink href={torrent}>
              <Download />
              Скачать .torrent
            </ActionLink>
          )}
          {r.MagnetUri && (
            <ActionLink href={r.MagnetUri}>
              <Magnet />
              Открыть magnet
            </ActionLink>
          )}
          {r.MagnetUri && <CopyButton value={r.MagnetUri} label="Копировать magnet" withText />}
        </div>

        {(r.Details || imdb || tmdb) && (
          <Section title="Ссылки">
            <div className="flex flex-wrap gap-2">
              {r.Details && (
                <ActionLink href={r.Details} newTab>
                  <ExternalLink />
                  Страница на трекере
                </ActionLink>
              )}
              {imdb && (
                <ActionLink href={imdb} newTab>
                  <ExternalLink />
                  IMDb
                </ActionLink>
              )}
              {tmdb && (
                <ActionLink href={tmdb} newTab>
                  <ExternalLink />
                  TMDb
                </ActionLink>
              )}
            </div>
          </Section>
        )}

        {r.InfoHash && (
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">Info hash</span>
            <code className="min-w-0 truncate font-mono">{r.InfoHash}</code>
            <CopyButton value={r.InfoHash} label="Копировать info hash" />
          </div>
        )}

        {desc && (
          <Section title="Описание">
            <Description html={desc} />
          </Section>
        )}

        <Section title="Файлы">
          <FileList r={r} />
        </Section>
      </div>
    </>
  );
}
