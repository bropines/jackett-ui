import { CheckCircle2 } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

export function Yes({ children }: { children: string }) {
  return (
    <Badge variant="success" className="gap-1">
      <CheckCircle2 className="h-3 w-3" aria-hidden /> {children}
    </Badge>
  );
}

export const No = ({ children }: { children: string }) => <Badge variant="outline">{children}</Badge>;

/**
 * One login method: icon, name, status badges, one-line explanation, on/off switch,
 * then notes, errors and actions (e.g. «Настроить»).
 */
export function MethodCard({
  id,
  icon,
  title,
  description,
  badges,
  switchLabel,
  on,
  canToggle,
  onToggle,
  error,
  children,
  actions,
  className,
}: {
  id: string;
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  badges?: ReactNode;
  switchLabel: string;
  on: boolean;
  canToggle: boolean;
  onToggle: (on: boolean) => void;
  error?: string;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <Card role="region" aria-labelledby={`${id}-title`} className={cn("space-y-3 p-4 shadow-none", className)}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-muted-foreground">{icon}</span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={`${id}-title`} className="text-sm font-semibold">
              {title}
            </h3>
            {badges}
          </div>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={cn("hidden text-xs sm:inline", on ? "text-foreground" : "text-muted-foreground")} aria-hidden>
            {on ? "Включён" : "Выключен"}
          </span>
          <Switch id={`${id}-switch`} aria-label={switchLabel} checked={on} onCheckedChange={onToggle} disabled={!canToggle} />
        </div>
      </div>
      {children && <div className="space-y-2 text-sm text-muted-foreground sm:pl-7">{children}</div>}
      {error && (
        <p role="alert" className="text-sm text-destructive sm:pl-7">
          {error}
        </p>
      )}
      {actions && <div className="flex flex-wrap gap-2 sm:pl-7">{actions}</div>}
    </Card>
  );
}
