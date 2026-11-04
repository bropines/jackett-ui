/**
 * «Панель» tab: UI server settings (GET /_ui/api/settings) ⇄ form state ⇄ partial PUT patch.
 * Only changed, unlocked fields go into the patch; an empty secret means "unchanged".
 *
 * Fields are addressed by their server path ("auth.providers.oidc.issuer"): the same key is
 * used for locks, env var hints, client validation and server errors (`{error, field}`).
 */
import {
  METHOD_IDS,
  PROVIDER_IDS,
  type Locked,
  type MethodId,
  type ProviderFields,
  type ProviderId,
  type Role,
  type UiSettings,
  type UiSettingsPatch,
} from "@/api/server";

export interface ProviderForm {
  clientId: string;
  /** New secret; "" = keep the stored one. */
  clientSecret: string;
  /** Remove the stored secret (sends null). */
  clearSecret: boolean;
  /* oidc only */
  issuer: string;
  providerName: string;
  scopes: string;
  /** Comma/newline separated. */
  allowedGroups: string;
  groupsClaim: string;
  allowUnverifiedEmail: boolean;
}

export interface AuthForm {
  methods: Record<MethodId, boolean>;
  disabled: boolean;
  autoProvision: boolean;
  defaultRole: Role;
  providers: Record<ProviderId, ProviderForm>;
  /** Comma/newline separated. */
  allowedEmails: string;
  adminEmails: string;
  githubUsers: string;
  headerName: string;
  headerTrusted: string;
  publicUrl: string;
  sessionTtl: string;
}

/** Field path, e.g. "auth.methods.oidc", "auth.providers.github.clientSecret", "publicUrl". */
export type FieldPath = string;
export type AuthErrors = Partial<Record<FieldPath, string>>;

export const P = {
  methods: "auth.methods",
  method: (id: MethodId) => `auth.methods.${id}`,
  disabled: "auth.disabled",
  autoProvision: "auth.autoProvision.enabled",
  defaultRole: "auth.autoProvision.role",
  allowedEmails: "auth.allowedEmails",
  adminEmails: "auth.adminEmails",
  githubUsers: "auth.githubUsers",
  headerName: "auth.header.name",
  headerTrusted: "auth.header.trusted",
  publicUrl: "publicUrl",
  sessionTtl: "sessionTtl",
  provider: (id: ProviderId, field: keyof ProviderFields) => `auth.providers.${id}.${field}`,
} as const;

/** Field path → env var that locks it (fallback when the server doesn't send `env`). */
export const ENV_VARS: Record<FieldPath, string> = {
  [P.methods]: "AUTH_METHODS",
  [P.disabled]: "AUTH_DISABLED",
  [P.autoProvision]: "AUTH_AUTO_PROVISION",
  [P.defaultRole]: "AUTH_DEFAULT_ROLE",
  [P.allowedEmails]: "AUTH_ALLOWED_EMAILS",
  [P.adminEmails]: "AUTH_ADMIN_EMAILS",
  [P.githubUsers]: "GITHUB_USERS",
  [P.headerName]: "AUTH_HEADER_NAME",
  [P.headerTrusted]: "AUTH_HEADER_TRUSTED",
  [P.publicUrl]: "PUBLIC_URL",
  [P.sessionTtl]: "SESSION_TTL",
  "auth.providers.oidc.issuer": "OIDC_ISSUER",
  "auth.providers.oidc.clientId": "OIDC_CLIENT_ID",
  "auth.providers.oidc.clientSecret": "OIDC_CLIENT_SECRET",
  "auth.providers.oidc.providerName": "OIDC_PROVIDER_NAME",
  "auth.providers.oidc.scopes": "OIDC_SCOPES",
  "auth.providers.oidc.allowedGroups": "OIDC_ALLOWED_GROUPS",
  "auth.providers.oidc.groupsClaim": "OIDC_GROUPS_CLAIM",
  "auth.providers.oidc.allowUnverifiedEmail": "OIDC_ALLOW_UNVERIFIED_EMAIL",
  "auth.providers.google.clientId": "GOOGLE_CLIENT_ID",
  "auth.providers.google.clientSecret": "GOOGLE_CLIENT_SECRET",
  "auth.providers.github.clientId": "GITHUB_CLIENT_ID",
  "auth.providers.github.clientSecret": "GITHUB_CLIENT_SECRET",
};

/** Normalizes a field path from the server or the form to the path that carries the lock. */
export function lockPath(path: FieldPath): FieldPath {
  return path.replace(/\.clientSecretSet$/, ".clientSecret");
}

/** Reads the `Locked<…>` node behind a field path (secrets → `clientSecretSet`). */
function lockedNode(s: UiSettings, path: FieldPath): Locked<unknown> | undefined {
  const p = lockPath(path).replace(/\.clientSecret$/, ".clientSecretSet");
  let node: unknown = s;
  for (const part of p.split(".")) node = node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
  return node && typeof node === "object" && "locked" in node ? (node as Locked<unknown>) : undefined;
}

export function isLocked(s: UiSettings, path: FieldPath): boolean {
  if (path === P.methods) return METHOD_IDS.some((m) => !!s.auth.methods?.[m]?.locked);
  return !!lockedNode(s, path)?.locked;
}

/** "задано переменной окружения OIDC_ISSUER" for locked fields, else undefined. */
export function lockedHint(s: UiSettings, path: FieldPath): string | undefined {
  if (!isLocked(s, path)) return undefined;
  const methodsNode = path === P.methods ? METHOD_IDS.map((m) => s.auth.methods?.[m]).find((n) => n?.locked) : undefined;
  const node = methodsNode ?? lockedNode(s, path);
  const env = node?.env || ENV_VARS[lockPath(path)] || (path.startsWith(`${P.methods}.`) ? ENV_VARS[P.methods] : undefined);
  return env ? `задано переменной окружения ${env}` : "задано переменной окружения";
}

/** Maps a server error field path to the form field path that shows it. */
export function errorPath(path: string | undefined): FieldPath | undefined {
  if (!path) return undefined;
  return path.replace(/\.clientSecretSet$/, ".clientSecret");
}

export function parseList(v: string): string[] {
  return v
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

const joinList = (v: string[] | null | undefined) => (v ?? []).join(", ");

function providerForm(s: UiSettings, id: ProviderId): ProviderForm {
  const p = s.auth.providers[id];
  const o = id === "oidc" ? s.auth.providers.oidc : undefined;
  return {
    clientId: p.clientId.value ?? "",
    clientSecret: "",
    clearSecret: false,
    issuer: o?.issuer.value ?? "",
    providerName: o?.providerName.value ?? "",
    scopes: o?.scopes.value ?? "",
    allowedGroups: joinList(o?.allowedGroups.value),
    groupsClaim: o?.groupsClaim.value ?? "",
    allowUnverifiedEmail: o?.allowUnverifiedEmail?.value ?? false,
  };
}

const methodValue = (s: UiSettings, m: MethodId) => !!s.auth.methods?.[m]?.value;

export function toAuthForm(s: UiSettings): AuthForm {
  const a = s.auth;
  return {
    methods: Object.fromEntries(METHOD_IDS.map((m) => [m, methodValue(s, m)])) as Record<MethodId, boolean>,
    disabled: !!a.disabled?.value,
    autoProvision: !!a.autoProvision?.enabled.value,
    defaultRole: a.autoProvision?.role.value ?? "viewer",
    providers: { oidc: providerForm(s, "oidc"), google: providerForm(s, "google"), github: providerForm(s, "github") },
    allowedEmails: joinList(a.allowedEmails.value),
    adminEmails: joinList(a.adminEmails?.value),
    githubUsers: joinList(a.githubUsers.value),
    headerName: a.header.name.value ?? "",
    headerTrusted: joinList(a.header.trusted.value),
    publicUrl: s.publicUrl.value ?? "",
    sessionTtl: s.sessionTtl.value ?? "",
  };
}

const sameList = (a: string[], b: string[] | null | undefined) => {
  const bb = b ?? [];
  return a.length === bb.length && a.every((x, i) => x === bb[i]);
};

/** Provider fields of the form as plain values (for the test request). */
export function providerFields(f: AuthForm, id: ProviderId): ProviderFields {
  const p = f.providers[id];
  const out: ProviderFields = { clientId: p.clientId.trim() };
  if (id === "oidc") {
    out.issuer = p.issuer.trim();
    out.providerName = p.providerName.trim();
    out.scopes = p.scopes.trim();
    out.allowedGroups = parseList(p.allowedGroups);
    out.groupsClaim = p.groupsClaim.trim();
    out.allowUnverifiedEmail = p.allowUnverifiedEmail;
  }
  if (p.clearSecret) out.clientSecret = null;
  else if (p.clientSecret) out.clientSecret = p.clientSecret;
  return out;
}

/**
 * Identity of the settings a test login verifies: client id, secret and (oidc) issuer + scopes.
 * Changing any of them makes the provider unverified again.
 */
export function verifyKey(f: AuthForm, id: ProviderId): string {
  const p = f.providers[id];
  const core: unknown[] = [p.clientId.trim(), p.clearSecret ? null : p.clientSecret];
  if (id === "oidc") core.push(p.issuer.trim(), p.scopes.trim());
  return JSON.stringify(core);
}

/** True when the provider's verified fields differ from the stored ones. */
export function providerCoreChanged(f: AuthForm, s: UiSettings, id: ProviderId): boolean {
  const p = f.providers[id];
  const sp = s.auth.providers[id];
  if (p.clientId.trim() !== (sp.clientId.value ?? "") || p.clientSecret !== "" || p.clearSecret) return true;
  if (id === "oidc") {
    const o = s.auth.providers.oidc;
    return p.issuer.trim() !== (o.issuer.value ?? "") || p.scopes.trim() !== (o.scopes.value ?? "");
  }
  return false;
}

/** A provider is configured when its client id is set. */
export function providerConfigured(f: AuthForm, id: ProviderId): boolean {
  return f.providers[id].clientId.trim() !== "";
}

export type TestedKeys = Partial<Record<ProviderId, string>>;

/** Whether the provider's settings in the form are verified (stored + verified, or tested in this session). */
export function providerVerified(f: AuthForm, s: UiSettings, id: ProviderId, tested: TestedKeys): boolean {
  if (tested[id] !== undefined && tested[id] === verifyKey(f, id)) return true;
  return s.auth.providers[id].verified && !providerCoreChanged(f, s, id);
}

/** Auto-provisioning through providers is refused while every allow-list is empty (secure default). */
export function allowListsEmpty(f: AuthForm): boolean {
  return (
    !parseList(f.allowedEmails).length &&
    !parseList(f.adminEmails).length &&
    !parseList(f.githubUsers).length &&
    !parseList(f.providers.oidc.allowedGroups).length
  );
}

/** Builds the partial PUT body: only changed, unlocked fields. */
export function buildPatch(f: AuthForm, s: UiSettings): UiSettingsPatch {
  const a = s.auth;
  const patch: UiSettingsPatch = {};
  const auth: NonNullable<UiSettingsPatch["auth"]> = {};
  const providers: NonNullable<NonNullable<UiSettingsPatch["auth"]>["providers"]> = {};
  const header: NonNullable<NonNullable<UiSettingsPatch["auth"]>["header"]> = {};
  const auto: NonNullable<NonNullable<UiSettingsPatch["auth"]>["autoProvision"]> = {};
  const free = (path: FieldPath) => !isLocked(s, path);

  if (free(P.methods) && METHOD_IDS.some((m) => f.methods[m] !== methodValue(s, m))) auth.methods = { ...f.methods };
  if (free(P.disabled) && f.disabled !== !!a.disabled?.value) {
    auth.disabled = f.disabled;
    if (f.disabled) patch.confirm = true;
  }
  if (free(P.autoProvision) && f.autoProvision !== !!a.autoProvision?.enabled.value) auto.enabled = f.autoProvision;
  if (free(P.defaultRole) && f.defaultRole !== (a.autoProvision?.role.value ?? "viewer")) auto.role = f.defaultRole;
  if (Object.keys(auto).length) auth.autoProvision = auto;

  const emails = parseList(f.allowedEmails);
  if (free(P.allowedEmails) && !sameList(emails, a.allowedEmails.value)) auth.allowedEmails = emails;
  const admins = parseList(f.adminEmails);
  if (free(P.adminEmails) && !sameList(admins, a.adminEmails?.value)) auth.adminEmails = admins;
  const ghUsers = parseList(f.githubUsers);
  if (free(P.githubUsers) && !sameList(ghUsers, a.githubUsers.value)) auth.githubUsers = ghUsers;

  for (const id of PROVIDER_IDS) {
    const p = f.providers[id];
    const sp = a.providers[id];
    const out: ProviderFields = {};
    const str = (k: "clientId" | "issuer" | "providerName" | "scopes" | "groupsClaim", cur: string | undefined) => {
      if (free(P.provider(id, k)) && p[k].trim() !== (cur ?? "")) out[k] = p[k].trim();
    };
    str("clientId", sp.clientId.value);
    if (free(P.provider(id, "clientSecret"))) {
      if (p.clearSecret) {
        if (sp.clientSecretSet.value) out.clientSecret = null;
      } else if (p.clientSecret) out.clientSecret = p.clientSecret;
    }
    if (id === "oidc") {
      const o = a.providers.oidc;
      str("issuer", o.issuer.value);
      str("providerName", o.providerName.value);
      str("scopes", o.scopes.value);
      str("groupsClaim", o.groupsClaim.value);
      const groups = parseList(p.allowedGroups);
      if (free(P.provider(id, "allowedGroups")) && !sameList(groups, o.allowedGroups.value)) out.allowedGroups = groups;
      if (free(P.provider(id, "allowUnverifiedEmail")) && p.allowUnverifiedEmail !== (o.allowUnverifiedEmail?.value ?? false))
        out.allowUnverifiedEmail = p.allowUnverifiedEmail;
    }
    if (Object.keys(out).length) providers[id] = out;
  }

  if (free(P.headerName) && f.headerName.trim() !== (a.header.name.value ?? "")) header.name = f.headerName.trim();
  const trusted = parseList(f.headerTrusted);
  if (free(P.headerTrusted) && !sameList(trusted, a.header.trusted.value)) header.trusted = trusted;

  if (Object.keys(providers).length) auth.providers = providers;
  if (Object.keys(header).length) auth.header = header;
  if (Object.keys(auth).length) patch.auth = auth;

  if (free(P.publicUrl) && f.publicUrl.trim() !== (s.publicUrl.value ?? "")) patch.publicUrl = f.publicUrl.trim();
  if (free(P.sessionTtl) && f.sessionTtl.trim() !== (s.sessionTtl.value ?? "")) patch.sessionTtl = f.sessionTtl.trim();
  return patch;
}

export function isEmptyPatch(p: UiSettingsPatch): boolean {
  return Object.keys(p).filter((k) => k !== "confirm").length === 0;
}

const HTTP_URL = /^https?:\/\/[^\s/]+/i;
const CIDR = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]*:[0-9a-f:.]*)\/\d{1,3}$/i;
/** Go duration: 168h, 30m, 1h30m, 90s. */
const DURATION = /^(?:\d+(?:\.\d+)?(?:h|m|s|ms))+$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

export function isCidr(v: string): boolean {
  if (!CIDR.test(v)) return false;
  const [ip = "", bits = ""] = v.split("/");
  const max = ip.includes(":") ? 128 : 32;
  if (Number(bits) > max) return false;
  return ip.includes(":") || ip.split(".").every((o) => Number(o) <= 255);
}

export function validateAuthForm(f: AuthForm, s: UiSettings, tested: TestedKeys): AuthErrors {
  const e: AuthErrors = {};
  const free = (path: FieldPath) => !isLocked(s, path);

  // Methods: at least one, providers only when configured and verified, header needs its settings.
  if (free(P.methods) && !f.disabled) {
    if (!METHOD_IDS.some((m) => f.methods[m])) e[P.methods] = "Включите хотя бы один способ входа";
    for (const id of PROVIDER_IDS) {
      if (!f.methods[id]) continue;
      if (!providerConfigured(f, id)) e[P.method(id)] = "Сначала укажите Client ID провайдера ниже";
      else if (!providerVerified(f, s, id, tested)) e[P.method(id)] = "Нажмите «Проверить вход» у провайдера ниже и войдите у него";
    }
  }
  // A provider that is on must stay verified when its core settings change.
  for (const id of PROVIDER_IDS) {
    if (f.methods[id] && providerConfigured(f, id) && providerCoreChanged(f, s, id) && !providerVerified(f, s, id, tested)) {
      e[P.provider(id, "clientId")] ??= "Настройки изменились: проверьте вход перед сохранением";
    }
  }

  const oidc = f.providers.oidc;
  const issuerPath = P.provider("oidc", "issuer");
  if (free(issuerPath)) {
    if (oidc.issuer.trim() && !HTTP_URL.test(oidc.issuer.trim())) e[issuerPath] = "Адрес вида https://auth.example.com/…";
    else if (providerConfigured(f, "oidc") && !oidc.issuer.trim()) e[issuerPath] = "Нужен, когда задан Client ID";
  }

  if (f.methods.header) {
    if (free(P.headerName) && !f.headerName.trim()) e[P.headerName] = "Укажите имя заголовка";
    if (free(P.headerTrusted) && parseList(f.headerTrusted).length === 0) e[P.headerTrusted] = "Укажите хотя бы одну сеть прокси, например 172.16.0.0/12";
  }
  if (free(P.headerTrusted)) {
    const bad = parseList(f.headerTrusted).filter((c) => !isCidr(c));
    if (bad.length) e[P.headerTrusted] = `Не похоже на сеть CIDR: ${bad.join(", ")}`;
  }

  for (const path of [P.allowedEmails, P.adminEmails] as const) {
    if (!free(path)) continue;
    const bad = parseList(path === P.allowedEmails ? f.allowedEmails : f.adminEmails).filter((x) => !EMAIL.test(x));
    if (bad.length) e[path] = `Не похоже на e-mail: ${bad.join(", ")}`;
  }

  if (free(P.publicUrl) && f.publicUrl.trim() && !HTTP_URL.test(f.publicUrl.trim())) e[P.publicUrl] = "Адрес вида https://jackett.example.com";
  if (free(P.sessionTtl) && f.sessionTtl.trim() && !DURATION.test(f.sessionTtl.trim())) e[P.sessionTtl] = "Например 168h, 24h или 30m";
  return e;
}

export function hasAuthErrors(e: AuthErrors): boolean {
  return Object.values(e).some(Boolean);
}
