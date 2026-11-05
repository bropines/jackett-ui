import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, type RouterHistory } from "@tanstack/react-router";

import { RequireRole } from "@/components/auth/RequireRole";
import { RootLayout } from "@/components/layout/RootLayout";
import { InvitePage } from "@/pages/auth/InvitePage";
import { DefinitionsPage, type DefinitionsPageSearch } from "@/pages/definitions/DefinitionsPage";
import { IndexersPage, type IndexersPageSearch } from "@/pages/IndexersPage";
import { LogsPage } from "@/pages/LogsPage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { ProfilePage } from "@/pages/ProfilePage";
import { SearchPage, type SearchPageSearch } from "@/pages/SearchPage";
import { parseSettingsTab, SettingsPage, type SettingsPageSearch } from "@/pages/SettingsPage";
import { WelcomePage, type WelcomePageSearch } from "@/pages/welcome/WelcomePage";

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
  component: RootLayout,
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

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  // tab = login | users | jackett | general; the old "panel" opens "login".
  validateSearch: (s: Record<string, unknown>): SettingsPageSearch => ({ tab: parseSettingsTab(str(s.tab)) }),
  component: () => (
    <RequireRole min="admin">
      <SettingsPage />
    </RequireRole>
  ),
});
const logsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/logs",
  component: () => (
    <RequireRole min="editor">
      <LogsPage />
    </RequireRole>
  ),
});
const definitionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/definitions",
  // edit = open the editor for this id; new=1 = a new file from the template.
  validateSearch: (s: Record<string, unknown>): DefinitionsPageSearch => ({ edit: str(s.edit), new: str(s.new) }),
  component: () => (
    <RequireRole min="admin">
      <DefinitionsPage />
    </RequireRole>
  ),
});
const profileRoute = createRoute({ getParentRoute: () => rootRoute, path: "/profile", component: ProfilePage });
const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/welcome",
  // step = methods; linked / authError come back from the provider link flow (read once, then stripped).
  validateSearch: (s: Record<string, unknown>): WelcomePageSearch => ({ step: str(s.step), linked: str(s.linked), authError: str(s.authError) }),
  component: WelcomePage,
});
const inviteRoute = createRoute({ getParentRoute: () => rootRoute, path: "/invite/$token", component: InvitePage });

const routeTree = rootRoute.addChildren([searchRoute, indexersRoute, settingsRoute, logsRoute, definitionsRoute, profileRoute, welcomeRoute, inviteRoute]);

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
