import type { ReactNode } from "react";

import { Card } from "@/components/ui/card";

/** One login method on the welcome page: icon, title, status badges, text and actions. */
export function MethodCard({
  id,
  icon,
  title,
  badges,
  children,
  actions,
}: {
  id: string;
  icon: ReactNode;
  title: ReactNode;
  badges?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Card role="region" aria-labelledby={`${id}-title`} className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <h2 id={`${id}-title`} className="text-base font-semibold">
          {title}
        </h2>
        {badges}
      </div>
      {children && <div className="space-y-2 text-sm text-muted-foreground">{children}</div>}
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </Card>
  );
}
