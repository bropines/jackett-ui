import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { onAuthRecheck, qk } from "@/api";
import { ErrorState } from "@/components/common";
import { WELCOME_PATH } from "@/lib/auth";
import { authStateQuery, resetSession } from "@/lib/auth-query";
import { LoginPage } from "@/pages/auth/LoginPage";
import { OnboardingPage } from "@/pages/auth/OnboardingPage";
import { SetupPage } from "@/pages/auth/SetupPage";

function FullScreen({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-4 text-sm text-muted-foreground">{children}</div>;
}

/**
 * Asks the jackett-ui server who we are (`/_ui/api/auth/state`) and shows the setup wizard,
 * the login page, the first-login wizard (`onboarding`) or the app. Any API call that finds the session gone re-triggers the check.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  // Optional: the gate is also rendered without a router (tests).
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | undefined;
  const state = useQuery(authStateQuery);

  useEffect(() => onAuthRecheck(() => void qc.invalidateQueries({ queryKey: qk.authState })), [qc]);

  if (state.isPending) {
    return (
      <FullScreen>
        <span className="inline-flex items-center gap-2" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Загрузка…
        </span>
      </FullScreen>
    );
  }
  if (state.isError || !state.data) {
    return (
      <FullScreen>
        <ErrorState error={state.error} onRetry={() => void state.refetch()} />
      </FullScreen>
    );
  }

  const s = state.data;
  const done = () => void resetSession(qc);
  /** After a new account was made: continue on the login methods page. */
  const toWelcome = (created: boolean) => {
    if (created) {
      if (router) void router.navigate({ to: "/welcome", search: { step: "methods" } });
      else window.history.pushState(null, "", WELCOME_PATH);
    }
    done();
  };
  if (s.setupRequired) return <SetupPage onDone={toWelcome} />;
  if (!s.authenticated) return <LoginPage state={s} onDone={done} />;
  if (s.onboarding && !s.disabled) return <OnboardingPage state={s} onDone={toWelcome} />;
  return <>{children}</>;
}
