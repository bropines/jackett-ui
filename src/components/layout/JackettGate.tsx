import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, PlugZap, RotateCw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ApiError, api, qk } from "@/api";
import { ErrorState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { jackettErrorText } from "@/lib/auth";
import { authStateQuery } from "@/lib/auth-query";

const JACKETT_CODES = new Set(["jackett_unreachable", "jackett_login_failed"]);

export function JackettError({ code, onRetry, busy }: { code: string | undefined; onRetry: () => void; busy?: boolean }) {
  const t = jackettErrorText(code);
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center" role="alert">
      <div className="rounded-full bg-destructive/10 p-3">
        <PlugZap className="h-5 w-5 text-destructive" aria-hidden />
      </div>
      <p className="font-medium">{t.title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{t.description}</p>
      <Button variant="outline" size="sm" className="mt-2" onClick={onRetry} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : <RotateCw />}
        Повторить
      </Button>
    </div>
  );
}

/**
 * Inside the app shell: shows a clear error when the server can't reach / log in to Jackett,
 * and loads the Jackett server config once (it carries the API key needed for search links).
 */
export function JackettGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const state = useQuery(authStateQuery);
  const jackettOk = state.data?.jackett.ok !== false;
  const cfg = useQuery({ queryKey: qk.serverConfig, queryFn: api.serverConfig, staleTime: 60_000, retry: false, enabled: jackettOk });
  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    setRetrying(true);
    try {
      const fresh = await qc.fetchQuery({ ...authStateQuery, staleTime: 0 });
      if (fresh.jackett.ok) await cfg.refetch();
    } catch {
      /* the gate shows the error */
    } finally {
      setRetrying(false);
    }
  };

  if (!jackettOk) return <JackettError code={state.data?.jackett.error} onRetry={() => void retry()} busy={retrying} />;

  if (cfg.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Подключаюсь к Jackett…
      </div>
    );
  }
  if (cfg.isError) {
    const code = cfg.error instanceof ApiError ? cfg.error.code : undefined;
    if (code && JACKETT_CODES.has(code)) return <JackettError code={code} onRetry={() => void retry()} busy={retrying} />;
    return <ErrorState error={cfg.error} onRetry={() => void cfg.refetch()} />;
  }
  return <>{children}</>;
}
