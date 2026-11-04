import { useQuery } from "@tanstack/react-query";
import { ShieldOff } from "lucide-react";
import type { ReactNode } from "react";

import type { Role } from "@/api";
import { EmptyState } from "@/components/common";
import { currentRole, roleAtLeast } from "@/lib/auth";
import { authStateQuery } from "@/lib/auth-query";

/** Friendly "403" for pages the current role can't use. */
export function Forbidden({ description }: { description?: ReactNode }) {
  return (
    <EmptyState
      icon={ShieldOff}
      title="Недостаточно прав"
      description={description ?? "Этот раздел доступен другой роли. Если он нужен, попросите администратора."}
    />
  );
}

/** Renders `children` only for `min` role or higher; the server enforces the same rule. */
export function RequireRole({ min, children }: { min: Role; children: ReactNode }) {
  const { data } = useQuery(authStateQuery);
  if (!data) return null;
  if (!roleAtLeast(currentRole(data), min)) return <Forbidden />;
  return <>{children}</>;
}
