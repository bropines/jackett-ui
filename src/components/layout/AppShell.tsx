import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { Menu, ShieldAlert, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { api, qk } from "@/api";
import { JackettGate } from "@/components/layout/JackettGate";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { UserMenu } from "@/components/layout/UserMenu";
import { Button } from "@/components/ui/button";
import { authStateQuery } from "@/lib/auth-query";
import { NAV } from "@/nav";

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-0.5 p-3" aria-label="Основное меню">
      {NAV.map((item) => (
        <Link
          key={item.path}
          to={item.path}
          onClick={onNavigate}
          activeOptions={{ exact: item.path === "/", includeSearch: false }}
          className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          activeProps={{ className: "bg-sidebar-accent font-medium !text-foreground" }}
        >
          <item.icon className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">{item.label}</span>
        </Link>
      ))}
    </nav>
  );
}

/** Sidebar footer: running Jackett and UI versions. */
function SidebarFooter() {
  const { data: auth } = useQuery(authStateQuery);
  const { data } = useQuery({
    queryKey: qk.serverConfig,
    queryFn: api.serverConfig,
    staleTime: 60_000,
    enabled: auth?.jackett.ok !== false,
  });
  return (
    <div className="mt-auto space-y-0.5 border-t border-sidebar-border px-5 py-2 text-xs text-muted-foreground">
      <div>Jackett {data?.app_version ?? auth?.jackett.version ?? ""}</div>
      {auth?.version && <div>UI {auth.version}</div>}
    </div>
  );
}

/** Red banner when authentication is off. */
function NoAuthBanner() {
  const { data } = useQuery(authStateQuery);
  if (data?.mode !== "none") return null;
  return (
    <div role="alert" className="flex items-start gap-2 bg-red-600 px-3 py-2 text-sm font-medium text-white dark:bg-red-700 md:px-5">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0">
        Вход отключён: любой, кто откроет адрес, управляет Jackett.{" "}
        <Link to="/settings" hash="auth" className="underline underline-offset-2">
          Включить вход
        </Link>
      </span>
    </div>
  );
}

function Brand() {
  return (
    <Link to="/" className="flex min-w-0 items-center gap-2 font-semibold">
      <img src="/favicon.svg" alt="" className="h-6 w-6 shrink-0" />
      <span className="truncate">Jackett</span>
    </Link>
  );
}

/** Layout: sidebar (drawer on mobile), top bar, routed content. */
export function AppShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => setMobileOpen(false), [pathname]);

  return (
    <div className="flex min-h-screen bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-background focus:p-2"
      >
        К содержимому
      </a>

      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar md:flex">
        <div className="flex h-14 shrink-0 items-center border-b border-sidebar-border px-4">
          <Brand />
        </div>
        <Sidebar />
        <SidebarFooter />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Основное меню">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col overflow-y-auto bg-sidebar shadow-xl">
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-sidebar-border px-4">
              <Brand />
              <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)} aria-label="Закрыть меню">
                <X />
              </Button>
            </div>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
            <SidebarFooter />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <NoAuthBanner />
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur md:px-5">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileOpen(true)} aria-label="Открыть меню">
            <Menu />
          </Button>
          <div className="min-w-0 md:hidden">
            <Brand />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1600px] flex-1 p-3 md:p-6">
          <JackettGate>{children}</JackettGate>
        </main>
      </div>
    </div>
  );
}
