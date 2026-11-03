import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";

import { ApiError, api, getNeedsPassword, onNeedsPassword, qk } from "@/api";
import { ErrorState } from "@/components/common";
import { LoginPage } from "@/pages/LoginPage";

/**
 * Loads the server config once (it carries the API key needed for search links).
 * Shows the password form when Jackett has an admin password and the session is gone.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [needsPassword, setNeedsPassword] = useState(getNeedsPassword());
  useEffect(() => onNeedsPassword(setNeedsPassword), []);
  const cfg = useQuery({ queryKey: qk.serverConfig, queryFn: api.serverConfig, staleTime: 60_000, retry: false });

  if (needsPassword || (cfg.error instanceof ApiError && cfg.error.status === 401)) {
    return <LoginPage onSuccess={() => void cfg.refetch()} />;
  }
  if (cfg.isPending) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Подключаюсь к Jackett…</div>;
  }
  if (cfg.error) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <ErrorState error={cfg.error} onRetry={() => void cfg.refetch()} />
      </div>
    );
  }
  return <>{children}</>;
}
