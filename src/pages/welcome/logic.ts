import { METHOD_IDS, type MethodId, type ProviderId, type UiSettings, type UiSettingsPatch } from "@/api/server";

/** `PUT /settings` body that switches one method on; `methods` always goes complete. */
export function enableMethodPatch(s: UiSettings, id: MethodId): UiSettingsPatch {
  const methods = Object.fromEntries(METHOD_IDS.map((m) => [m, m === id ? true : !!s.auth.methods?.[m]?.value])) as Record<MethodId, boolean>;
  return { auth: { methods } };
}

export interface ProviderStatus {
  configured: boolean;
  verified: boolean;
  on: boolean;
}

export function providerStatus(s: UiSettings, id: ProviderId): ProviderStatus {
  const p = s.auth.providers[id];
  const configured = (p.clientId.value ?? "").trim() !== "";
  return { configured, verified: configured && p.verified, on: !!s.auth.methods?.[id]?.value };
}

/** Keeps only the errors of one provider's fields. */
export function providerErrors<T extends Record<string, string | undefined>>(errors: T, id: ProviderId): Partial<T> {
  const prefix = `auth.providers.${id}.`;
  return Object.fromEntries(Object.entries(errors).filter(([k, v]) => k.startsWith(prefix) && v)) as Partial<T>;
}
