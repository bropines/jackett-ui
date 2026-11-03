import { ListChecks, ScrollText, Search, Settings, type LucideIcon } from "lucide-react";

/** One sidebar entry; `path` doubles as the route path. */
export interface NavItem {
  path: "/" | "/indexers" | "/settings" | "/logs";
  label: string;
  icon: LucideIcon;
}

export const NAV: NavItem[] = [
  { path: "/", label: "Поиск", icon: Search },
  { path: "/indexers", label: "Трекеры", icon: ListChecks },
  { path: "/settings", label: "Настройки", icon: Settings },
  { path: "/logs", label: "Журнал", icon: ScrollText },
];
