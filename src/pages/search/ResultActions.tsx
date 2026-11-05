import { Download, ExternalLink, Magnet, PanelRightOpen } from "lucide-react";

import { localizeLink, type SearchResult } from "@/api";
import { CopyButton } from "@/components/common";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

const btn =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&_svg]:size-4";

function IconLink({ href, label, newTab, children }: { href: string; label: string; newTab?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={href}
          className={btn}
          aria-label={label}
          {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </a>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Magnet / .torrent / copy magnet / tracker page / preview. Buttons without data are hidden. */
export function ResultActions({ r, className, onPreview }: { r: SearchResult; className?: string; onPreview?: () => void }) {
  const torrent = localizeLink(r.Link);
  return (
    <div className={cn("flex items-center justify-end gap-0.5", className)}>
      {onPreview && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={btn}
              aria-label="Подробнее"
              aria-haspopup="dialog"
              onClick={(e) => {
                e.stopPropagation();
                onPreview();
              }}
            >
              <PanelRightOpen />
            </button>
          </TooltipTrigger>
          <TooltipContent>Подробнее</TooltipContent>
        </Tooltip>
      )}
      {r.MagnetUri && (
        <IconLink href={r.MagnetUri} label="Открыть magnet">
          <Magnet />
        </IconLink>
      )}
      {torrent && (
        <IconLink href={torrent} label="Скачать .torrent">
          <Download />
        </IconLink>
      )}
      {r.MagnetUri && <CopyButton value={r.MagnetUri} label="Копировать magnet" />}
      {r.Details && (
        <IconLink href={r.Details} label="Страница на трекере" newTab>
          <ExternalLink />
        </IconLink>
      )}
    </div>
  );
}
