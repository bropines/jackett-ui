import DOMPurify from "dompurify";
import { useMemo } from "react";

import { cn } from "@/lib/utils";

const ALLOWED_TAGS = ["a", "b", "strong", "i", "em", "br", "p", "ul", "ol", "li", "code", "span", "u"];

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Renders tracker-provided HTML (indexer help texts) after sanitizing it. The only place raw HTML is allowed. */
export function SafeHtml({ html, className }: { html: string | null | undefined; className?: string }) {
  const clean = useMemo(() => DOMPurify.sanitize(html ?? "", { ALLOWED_TAGS, ALLOWED_ATTR: ["href", "target", "rel"] }), [html]);
  if (!clean) return null;
  return (
    <div
      className={cn(
        "text-sm text-muted-foreground [&_a]:text-primary [&_a]:underline [&_b]:text-foreground [&_strong]:text-foreground",
        className,
      )}
      // eslint-disable-next-line no-restricted-syntax -- sanitized above with DOMPurify
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}
