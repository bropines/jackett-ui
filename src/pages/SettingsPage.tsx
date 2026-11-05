import { useNavigate, useSearch } from "@tanstack/react-router";
import { KeyRound, Server, SlidersHorizontal, Users } from "lucide-react";

import { Forbidden } from "@/components/auth/RequireRole";
import { PageHeader } from "@/components/common";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { useRole } from "@/lib/auth-hooks";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/pages/search/useMediaQuery";
import { GeneralTab } from "@/pages/settings/general/GeneralTab";
import { JackettTab } from "@/pages/settings/JackettTab";
import { LoginTab } from "@/pages/settings/login/LoginTab";
import { parseSettingsTab, SETTINGS_TABS, type SettingsTab } from "@/pages/settings/sections";
import { SignupSection } from "@/pages/settings/users/SignupSection";
import { UsersTab } from "@/pages/settings/users/UsersTab";

export type { SettingsTab };
export { parseSettingsTab };

export interface SettingsPageSearch {
  /** "panel" is the old name of "login", still accepted in links. */
  tab?: SettingsTab | "panel";
}

const TAB_META: Record<SettingsTab, { label: string; icon: React.ComponentType<{ className?: string }>; description?: string }> = {
  login: { label: "Вход", icon: KeyRound, description: "Как входят в панель. Переключатели сохраняются сразу." },
  users: { label: "Пользователи", icon: Users, description: "Кто может входить и с какими правами." },
  jackett: { label: "Jackett", icon: Server },
  general: { label: "Общее", icon: SlidersHorizontal, description: "Адрес панели и время сеанса." },
};

/** Settings with tabs; the active tab lives in the URL (`?tab=`). Admin only. */
export function SettingsTabs({ tab, onTabChange }: { tab: SettingsTab; onTabChange: (tab: SettingsTab) => void }) {
  const role = useRole();
  const desktop = useMediaQuery("(min-width: 768px)");
  if (role !== "admin") {
    return (
      <>
        <PageHeader title="Настройки" />
        <Forbidden description="Настройки доступны только администраторам." />
      </>
    );
  }
  return (
    <div className="min-w-0">
      <PageHeader title="Настройки" />
      <Tabs
        value={tab}
        onValueChange={(v) => onTabChange(v as SettingsTab)}
        orientation={desktop ? "vertical" : "horizontal"}
        className="md:grid md:grid-cols-[11rem_minmax(0,1fr)] md:items-start md:gap-6"
      >
        <TabsList
          aria-label="Разделы настроек"
          className="w-full md:sticky md:top-4 md:h-auto md:flex-col md:items-stretch md:gap-1 md:bg-transparent md:p-0"
        >
          {SETTINGS_TABS.map((t) => {
            const { label, icon: Icon } = TAB_META[t];
            return (
              <TabsTrigger
                key={t}
                value={t}
                className={cn(
                  "flex-1 md:flex-none md:justify-start md:px-3 md:py-2",
                  "md:data-[state=active]:bg-muted md:data-[state=active]:shadow-none md:hover:bg-muted/60",
                )}
              >
                <Icon aria-hidden /> {label}
              </TabsTrigger>
            );
          })}
        </TabsList>
        {SETTINGS_TABS.map((t) => (
          <TabsContent key={t} value={t} className="mx-auto w-full min-w-0 max-w-3xl md:mt-0">
            {TAB_META[t].description && <p className="mb-4 text-sm text-muted-foreground">{TAB_META[t].description}</p>}
            {t === "login" && <LoginTab onOpenTab={onTabChange} />}
            {t === "users" && (
              <div className="space-y-6">
                <UsersTab />
                <SignupSection />
              </div>
            )}
            {t === "jackett" && <JackettTab />}
            {t === "general" && <GeneralTab />}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

export function SettingsPage() {
  const search = useSearch({ from: "/settings" });
  const navigate = useNavigate({ from: "/settings" });
  return (
    <SettingsTabs
      tab={parseSettingsTab(search.tab) ?? "login"}
      onTabChange={(tab) => void navigate({ search: { tab: tab === "login" ? undefined : tab }, replace: true })}
    />
  );
}
