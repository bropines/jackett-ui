import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, PlugZap, RotateCw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { jackettErrorText } from "@/lib/auth";
import { authStateQuery } from "@/lib/auth-query";

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
 * Inside the app shell: shows a clear error when the server can't reach / log in to Jackett
 * (reported by `auth/state`). Pages show their own errors for individual calls.
 */
export function JackettGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const state = useQuery(authStateQuery);
  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    setRetrying(true);
    try {
      await qc.fetchQuery({ ...authStateQuery, staleTime: 0 });
    } catch {
      /* the gate shows the error */
    } finally {
      setRetrying(false);
    }
  };

  if (state.data?.jackett.ok === false) return <JackettError code={state.data.jackett.error} onRetry={() => void retry()} busy={retrying} />;
  return <>{children}</>;
}
