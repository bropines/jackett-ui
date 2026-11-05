import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { errText, providerTestToken, qk, serverApi, waitForProviderTest, type ProviderFields, type ProviderId } from "@/api";
import type { TestState } from "@/pages/settings/auth/ProviderSection";

export const IDLE_TEST: TestState = { status: "idle" };

/**
 * Test logins of providers: opens the provider's login in a new tab and polls the result.
 * `onVerified(id, key)` runs when the login succeeded; `key` is what the caller passed to `start`.
 */
export function useProviderTests(onVerified: (id: ProviderId, key: string) => void) {
  const qc = useQueryClient();
  const [tests, setTests] = useState<Partial<Record<ProviderId, TestState>>>({});
  const polls = useRef<Partial<Record<ProviderId, AbortController>>>({});
  const verified = useRef(onVerified);
  useEffect(() => {
    verified.current = onVerified;
  });

  useEffect(() => () => Object.values(polls.current).forEach((c) => c?.abort()), []);

  const setTest = (id: ProviderId, t: TestState) => setTests((m) => ({ ...m, [id]: t }));

  const start = useCallback(
    async (id: ProviderId, fields: ProviderFields, key: string) => {
      polls.current[id]?.abort();
      // Open the tab synchronously (inside the click) so popup blockers let it through.
      const win = window.open("about:blank", "_blank");
      setTest(id, { status: "starting" });
      try {
        const { url } = await serverApi.testProvider(id, fields);
        if (win && !win.closed) {
          win.opener = null;
          win.location.href = url;
        }
        setTest(id, { status: "waiting", url, popupBlocked: !win });
        const token = providerTestToken(url);
        const ac = new AbortController();
        polls.current[id] = ac;
        let failMessage: string | undefined;
        const outcome = token ? await waitForProviderTest(id, token, { signal: ac.signal, onFailed: (m) => (failMessage = m) }) : "timeout";
        if (outcome === "cancelled") return;
        if (outcome === "verified") {
          verified.current(id, key);
          setTest(id, IDLE_TEST);
          toast.success("Вход через провайдера проверен");
          void qc.invalidateQueries({ queryKey: qk.uiSettings });
        } else if (outcome === "failed") {
          setTest(id, { status: "failed", message: failMessage || "Провайдер не подтвердил вход" });
        } else {
          setTest(id, { status: "timeout" });
        }
      } catch (e) {
        win?.close();
        setTest(id, { status: "failed", message: errText(e) });
      }
    },
    [qc],
  );

  const cancel = useCallback((id: ProviderId) => {
    polls.current[id]?.abort();
    setTest(id, IDLE_TEST);
  }, []);

  return { get: (id: ProviderId): TestState => tests[id] ?? IDLE_TEST, start, cancel };
}
