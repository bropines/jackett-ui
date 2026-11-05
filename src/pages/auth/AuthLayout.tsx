import type { ReactNode } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Centered card used by the setup wizard and the login page. */
export function AuthLayout({
  title,
  description,
  children,
  wide,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** max-w-lg instead of max-w-sm (forms with more fields). */
  wide?: boolean;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className={cn("w-full", wide ? "max-w-lg" : "max-w-sm")}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <img src="/favicon.svg" alt="" className="h-6 w-6" /> {title}
          </CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
      </Card>
    </div>
  );
}
