import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import type { Role } from "@/api";
import { currentRole, roleAtLeast } from "@/lib/auth";
import { authStateQuery } from "@/lib/auth-query";

/** Effective role of the current visitor (null while unknown / logged out). */
export function useRole(): Role | null {
  const { data } = useQuery(authStateQuery);
  return currentRole(data);
}

/** True when the current role is `min` or higher. */
export function useCan(min: Role): boolean {
  return roleAtLeast(useRole(), min);
}

/** Reads `?authError=` (set by the login / link callback) once and removes it from the address bar. */
export function useAuthErrorParam(): string | null {
  const [code] = useState(() => new URLSearchParams(window.location.search).get("authError"));
  useEffect(() => {
    if (!code) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("authError");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [code]);
  return code;
}

/** Reads `?linked=<provider>` (set by the server after a successful link) once and strips it. */
export function useLinkedParam(): string | null {
  const [id] = useState(() => new URLSearchParams(window.location.search).get("linked"));
  useEffect(() => {
    if (!id) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("linked");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [id]);
  return id;
}

/** Where to come back after the IdP: the current page without `authError`. */
export function currentReturnPath(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("authError");
  return `${url.pathname}${url.search}`;
}
