import { ImageOff } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import { posterUrl } from "./logic";

/**
 * Poster image in a fixed-size box (no layout shift): lazy, no referrer, and a neutral
 * placeholder when it fails to load (dead link, blocked by CSP, http on https…).
 */
export function Poster({ src, alt = "", className, iconClassName }: { src: string | null | undefined; alt?: string; className?: string; iconClassName?: string }) {
  const url = posterUrl(src);
  const [failed, setFailed] = useState<string | null>(null);
  const broken = !url || failed === url;
  return (
    <span className={cn("relative block shrink-0 overflow-hidden rounded bg-muted", className)}>
      {broken ? (
        <span className="absolute inset-0 flex items-center justify-center text-muted-foreground/60" aria-hidden>
          <ImageOff className={cn("h-4 w-4", iconClassName)} />
        </span>
      ) : (
        <img
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setFailed(url)}
        />
      )}
    </span>
  );
}

/** Small row/card thumbnail; renders nothing when the result has no poster. */
export function PosterThumb({ src, className }: { src: string | null | undefined; className?: string }) {
  if (!posterUrl(src)) return null;
  return <Poster src={src} className={cn("h-12 w-8", className)} iconClassName="h-3.5 w-3.5" />;
}
