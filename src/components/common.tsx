import { AlertTriangle, Check, Copy, Inbox, Info, RotateCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { errText, isForbidden } from "@/api";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/misc";
import { formatDateTime, isSet, relativeTime } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {back && <div className="mb-1 text-sm">{back}</div>}
        <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight md:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-4 py-12 text-center", className)}>
      <div className="rounded-full bg-muted p-3">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-4 py-12 text-center", className)} role="alert">
      <div className="rounded-full bg-destructive/10 p-3">
        <AlertTriangle className="h-5 w-5 text-destructive" />
      </div>
      <p className="font-medium">{isForbidden(error) ? "Недостаточно прав" : "Не удалось загрузить данные"}</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        {isForbidden(error) ? "Это действие доступно другой роли. Если оно нужно, попросите администратора." : errText(error)}
      </p>
      {onRetry && !isForbidden(error) && (
        <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
          <RotateCw />
          Повторить
        </Button>
      )}
    </div>
  );
}

/** Inline alert box (info / warning / error). */
export function Callout({
  variant = "info",
  title,
  children,
  className,
}: {
  variant?: "info" | "warning" | "error";
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const Icon = variant === "info" ? Info : AlertTriangle;
  return (
    <div
      role={variant === "error" ? "alert" : "note"}
      className={cn(
        "flex items-start gap-2 rounded-md border p-3 text-sm",
        variant === "info" && "border-primary/30 bg-primary/5",
        variant === "warning" && "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
        variant === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
        className,
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-1">
        {title && <div className="font-medium">{title}</div>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

/** Shows a toast for a failed mutation. */
export function toastError(err: unknown) {
  toast.error(errText(err));
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  pending,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: ReactNode;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Отмена</AlertDialogCancel>
          <Button variant={destructive ? "destructive" : "default"} disabled={pending} onClick={() => onConfirm()}>
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts (plain http in a LAN).
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({
  value,
  label = "Копировать",
  className,
  withText,
}: {
  value: string | (() => string);
  label?: string;
  className?: string;
  /** Render a labelled outline button instead of an icon button. */
  withText?: boolean;
}) {
  const [done, setDone] = useState(false);
  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyText(typeof value === "function" ? value() : value);
    if (ok) {
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    } else {
      toast.error("Не удалось скопировать");
    }
  };
  const icon = done ? <Check className="text-emerald-600" /> : <Copy />;
  if (withText)
    return (
      <Button type="button" variant="outline" size="sm" className={className} onClick={onClick}>
        {icon}
        {done ? "Скопировано" : label}
      </Button>
    );
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground", className)}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {icon}
    </Button>
  );
}

/** Monospace value in a bordered box with a copy button. */
export function CopyField({ value, label, className }: { value: string; label?: string; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 rounded-md border bg-muted/40 py-1.5 pl-3 pr-1.5", className)}>
      <Mono className="min-w-0 flex-1 break-all text-sm">{value}</Mono>
      <CopyButton value={value} label={label} />
    </div>
  );
}

export function RelativeTime({ iso, className, never = "—" }: { iso: string | null | undefined; className?: string; never?: string }) {
  const now = useNow(15_000);
  if (!isSet(iso)) return <span className={cn("text-muted-foreground", className)}>{never}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={iso ?? undefined} className={cn("whitespace-nowrap", className)}>
          {relativeTime(iso, now)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{formatDateTime(iso)}</TooltipContent>
    </Tooltip>
  );
}

/** Coloured status dot: green ok, red failure, grey unknown. */
export function StatusDot({ ok, label, className }: { ok: boolean | null | undefined; label?: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-2.5 w-2.5 shrink-0 rounded-full",
        ok == null ? "bg-zinc-300 dark:bg-zinc-600" : ok ? "bg-emerald-500" : "bg-destructive",
        className,
      )}
      title={label}
      role="img"
      aria-label={label ?? (ok == null ? "неизвестно" : ok ? "в порядке" : "ошибка")}
    />
  );
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  error?: string | undefined;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[0.8125rem] tabular-nums", className)}>{children}</span>;
}

/** Small "i" with a tooltip. */
export function HelpTip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className={cn("inline-flex align-middle text-muted-foreground hover:text-foreground", className)} aria-label="Подсказка">
          <Info className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs whitespace-normal leading-relaxed">{children}</TooltipContent>
    </Tooltip>
  );
}
