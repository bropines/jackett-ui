import { useQuery } from "@tanstack/react-query";

import { qk, serverApi, type Passkey } from "@/api";
import { useCan } from "@/lib/auth-hooks";
import { createPasskey, passkeysSupported } from "@/lib/webauthn";

export const PASSKEY_NAME_MAX = 64;

/** Registers a passkey for the logged-in user: begin → browser ceremony → finish. */
export async function registerPasskey(name: string): Promise<Passkey> {
  const { ceremony, publicKey } = await serverApi.beginMyPasskey();
  const credential = await createPasskey(publicKey);
  return serverApi.finishMyPasskey({ ceremony, name: name.trim(), credential });
}

/** Default name: the platform, e.g. "Windows", "iPhone". */
export function defaultPasskeyName(ua = typeof navigator !== "undefined" ? navigator.userAgent : ""): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac OS X|Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return "Passkey";
}

export interface PasskeyAvailability {
  /** The browser can do WebAuthn. */
  browser: boolean;
  /** Server view (admins only; undefined = unknown). */
  available?: boolean;
  reason?: string;
  /** The passkey login method is on (admins only; undefined = unknown). */
  methodOn?: boolean;
}

/** Whether passkeys can work here. Admins also learn the server's reason from the settings. */
export function usePasskeyAvailability(): PasskeyAvailability {
  const admin = useCan("admin");
  const settings = useQuery({ queryKey: qk.uiSettings, queryFn: () => serverApi.getSettings(), enabled: admin, refetchOnWindowFocus: false });
  const p = settings.data?.auth.passkey;
  return {
    browser: passkeysSupported(),
    available: p?.available,
    reason: p?.reason,
    methodOn: settings.data ? !!settings.data.auth.methods?.passkey?.value : undefined,
  };
}
