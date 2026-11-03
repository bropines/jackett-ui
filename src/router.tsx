import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, Outlet, type RouterHistory } from "@tanstack/react-router";

import { AppShell } from "@/components/layout/AppShell";
import { AuthGate } from "@/components/layout/AuthGate";
import { TooltipProvider } from "@/components/ui/misc";
import { Toaster } from "@/components/ui/sonner";
import { IndexersPage, type IndexersPageSearch } from "@/pages/IndexersPage";
import { LogsPage } from "@/pages/LogsPage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { SearchPage, type SearchPageSearch } from "@/pages/SearchPage";
import { SettingsPage } from "@/pages/SettingsPage";

export interface RouterContext {
  queryClient: QueryClient;
}

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined);

/** Plain query strings (?q=1080p&t=rutor,kinozal) instead of TanStack's JSON-encoded values. */
function parseSearch(search: string): Record<string, unknown> {
  return Object.fromEntries(new URLSearchParams(search));
}
function stringifySearch(obj: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <TooltipProvider delayDuration={300}>
      <AuthGate>
        <AppShell>
          <Outlet />
        </AppShell>
      </AuthGate>
      <Toaster richColors closeButton />
    </TooltipProvider>
  ),
  notFoundComponent: NotFoundPage,
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  // q = query, t = tracker ids (comma-separated), c = category ids (comma-separated): shareable search URLs.
  validateSearch: (s: Record<string, unknown>): SearchPageSearch => ({ q: str(s.q), t: str(s.t), c: str(s.c) }),
  component: SearchPage,
});

const indexersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/indexers",
  // add = open the "add indexer" catalog; edit = open the config dialog of this indexer id.
  validateSearch: (s: Record<string, unknown>): IndexersPageSearch => ({ add: str(s.add), edit: str(s.edit) }),
  component: IndexersPage,
});

const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });
const logsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/logs", component: LogsPage });

const routeTree = rootRoute.addChildren([searchRoute, indexersRoute, settingsRoute, logsRoute]);

export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: { queryClient },
    history,
    defaultPreload: "intent",
    scrollRestoration: true,
    parseSearch,
    stringifySearch,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
