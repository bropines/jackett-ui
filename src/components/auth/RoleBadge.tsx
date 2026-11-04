import type { Role } from "@/api";
import { Badge } from "@/components/ui/badge";
import { ROLE_LABELS } from "@/lib/auth";
import { cn } from "@/lib/utils";

const STYLE: Record<Role, string> = {
  admin: "border-transparent bg-red-500/10 text-red-700 dark:bg-red-500/20 dark:text-red-300",
  editor: "border-transparent bg-amber-500/10 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300",
  viewer: "border-transparent bg-secondary text-secondary-foreground",
};

export function RoleBadge({ role, className }: { role: Role; className?: string }) {
  return <Badge className={cn("font-medium", STYLE[role] ?? STYLE.viewer, className)}>{ROLE_LABELS[role] ?? role}</Badge>;
}
