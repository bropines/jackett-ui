import { useNavigate, useSearch } from "@tanstack/react-router";
import { Server, ShieldCheck, Users } from "lucide-react";

import { Forbidden } from "@/components/auth/RequireRole";
import { PageHeader } from "@/components/common";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { useRole } from "@/lib/auth-hooks";
import { PanelTab } from "@/pages/settings/auth/PanelTab";
import { JackettTab } from "@/pages/settings/JackettTab";
import { UsersTab } from "@/pages/settings/users/UsersTab";

export type SettingsTab = "panel" | "users" | "jackett";

export interface SettingsPageSearch {
  tab?: SettingsTab;
}

/** Settings with tabs; the active tab lives in the URL (`?tab=`). Admin only. */
export function SettingsTabs({ tab, onTabChange }: { tab: SettingsTab; onTabChange: (tab: SettingsTab) => void }) {
  const role = useRole();
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
      <Tabs value={tab} onValueChange={(v) => onTabChange(v as SettingsTab)}>
        <TabsList aria-label="Разделы настроек">
          <TabsTrigger value="panel">
            <ShieldCheck aria-hidden /> Панель
          </TabsTrigger>
          <TabsTrigger value="users">
            <Users aria-hidden /> Пользователи
          </TabsTrigger>
          <TabsTrigger value="jackett">
            <Server aria-hidden /> Jackett
          </TabsTrigger>
        </TabsList>
        <TabsContent value="panel">
          <PanelTab />
        </TabsContent>
        <TabsContent value="users">
          <UsersTab />
        </TabsContent>
        <TabsContent value="jackett">
          <JackettTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function SettingsPage() {
  const search = useSearch({ from: "/settings" });
  const navigate = useNavigate({ from: "/settings" });
  return (
    <SettingsTabs
      tab={search.tab ?? "panel"}
      onTabChange={(tab) => void navigate({ search: { tab: tab === "panel" ? undefined : tab }, replace: true })}
    />
  );
}
