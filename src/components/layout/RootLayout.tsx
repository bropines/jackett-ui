import { Outlet, useRouterState } from "@tanstack/react-router";

import { AppShell } from "@/components/layout/AppShell";
import { AuthGate } from "@/components/layout/AuthGate";
import { TooltipProvider } from "@/components/ui/misc";
import { Toaster } from "@/components/ui/sonner";

/** Pages reachable without a session (no app shell, no auth gate). */
const isPublicPath = (path: string) => path.startsWith("/invite/");

/** Root of the route tree: public pages as-is, everything else behind the auth gate and inside the app shell. */
export function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <TooltipProvider delayDuration={300}>
      {isPublicPath(pathname) ? (
        <Outlet />
      ) : (
        <AuthGate>
          <AppShell>
            <Outlet />
          </AppShell>
        </AuthGate>
      )}
      <Toaster richColors closeButton />
    </TooltipProvider>
  );
}
