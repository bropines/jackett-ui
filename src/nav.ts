import { ListChecks, ScrollText, Search, Settings, type LucideIcon } from "lucide-react";

import type { Role } from "@/api";
import { roleAtLeast } from "@/lib/auth";

/** One sidebar entry; `path` doubles as the route path. */
export interface NavItem {
  path: "/" | "/indexers" | "/settings" | "/logs";
  label: string;
  icon: LucideIcon;
  /** Lowest role that sees the entry (the server enforces the same rule). */
  minRole: Role;
}

export const NAV: NavItem[] = [
  { path: "/", label: "Поиск", icon: Search, minRole: "viewer" },
  { path: "/indexers", label: "Трекеры", icon: ListChecks, minRole: "viewer" },
  { path: "/settings", label: "Настройки", icon: Settings, minRole: "admin" },
  { path: "/logs", label: "Журнал", icon: ScrollText, minRole: "editor" },
];

/** Sidebar entries visible to `role`. */
export function navFor(role: Role | null): NavItem[] {
  return NAV.filter((item) => roleAtLeast(role, item.minRole));
}
