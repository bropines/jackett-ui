import { Globe, Lock, LockOpen, ShieldHalf } from "lucide-react";

import type { IndexerType } from "@/api";
import { cn } from "@/lib/utils";
import { languageName, languageShort, TYPE_LABELS } from "@/pages/indexers/logic";

const TYPE_STYLE: Record<IndexerType, string> = {
  public: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  "semi-private": "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  private: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
};

const TYPE_ICON: Record<IndexerType, typeof Lock> = {
  public: LockOpen,
  "semi-private": ShieldHalf,
  private: Lock,
};

export function TypeBadge({ type, className }: { type: IndexerType; className?: string }) {
  const Icon = TYPE_ICON[type] ?? Globe;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0 text-[11px] font-medium leading-5",
        TYPE_STYLE[type] ?? "text-muted-foreground",
        className,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {TYPE_LABELS[type] ?? type}
    </span>
  );
}

export function LangBadge({ code, className }: { code: string; className?: string }) {
  if (!code) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded border px-1 font-mono text-[10px] font-medium leading-4 text-muted-foreground",
        className,
      )}
      title={`${languageName(code)} (${code})`}
      aria-label={`Язык: ${languageName(code)}`}
    >
      {languageShort(code)}
    </span>
  );
}
