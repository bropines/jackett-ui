import type { QueryClient } from "@tanstack/react-query";

import { qk, serverApi } from "@/api";

/** Shared options for the `/_ui/api/auth/state` query (gate, header, settings). */
export const authStateQuery = {
  queryKey: qk.authState,
  queryFn: () => serverApi.authState(),
  staleTime: 30_000,
  retry: 1,
} as const;

/** Drops cached Jackett data (it belonged to the previous session) and re-reads the auth state. */
export async function resetSession(qc: QueryClient) {
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== qk.authState[0] });
  await qc.invalidateQueries({ queryKey: qk.authState });
}
