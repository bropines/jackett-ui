/**
 * WebAuthn (passkeys) without dependencies. The server sends the options in their JSON form
 * (binary fields as base64url) and expects `PublicKeyCredential.toJSON()` back. Browsers that
 * have `parse*OptionsFromJSON` / `toJSON` use them; others get the same conversion by hand.
 */

/* ── base64url ── */

export function bufferToBase64url(data: ArrayBuffer | ArrayBufferView): string {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlToBuffer(s: string): ArrayBuffer {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/* ── options: JSON → native ── */

type Json = Record<string, unknown>;
type CredDescriptorJSON = { id: string; type: string; transports?: string[] };

/** The server may send `{publicKey: {...}}` (go-webauthn's wrapper) or the options themselves. */
function unwrap(options: unknown): Json {
  const o = (options && typeof options === "object" ? options : {}) as Json;
  return o.publicKey && typeof o.publicKey === "object" ? (o.publicKey as Json) : o;
}

const descriptors = (list: unknown): PublicKeyCredentialDescriptor[] | undefined =>
  Array.isArray(list)
    ? (list as CredDescriptorJSON[]).map((c) => ({
        ...c,
        type: c.type as PublicKeyCredentialType,
        id: base64urlToBuffer(c.id),
        transports: c.transports as AuthenticatorTransport[] | undefined,
      }))
    : undefined;

/** Manual `PublicKeyCredential.parseCreationOptionsFromJSON`. */
export function creationOptionsFromJSON(options: unknown): PublicKeyCredentialCreationOptions {
  const o = unwrap(options);
  const user = (o.user ?? {}) as Json;
  const out = {
    ...o,
    challenge: base64urlToBuffer(String(o.challenge ?? "")),
    user: { ...user, id: base64urlToBuffer(String(user.id ?? "")) },
  } as unknown as PublicKeyCredentialCreationOptions;
  const exclude = descriptors(o.excludeCredentials);
  if (exclude) out.excludeCredentials = exclude;
  return out;
}

/** Manual `PublicKeyCredential.parseRequestOptionsFromJSON`. */
export function requestOptionsFromJSON(options: unknown): PublicKeyCredentialRequestOptions {
  const o = unwrap(options);
  const out = { ...o, challenge: base64urlToBuffer(String(o.challenge ?? "")) } as unknown as PublicKeyCredentialRequestOptions;
  const allow = descriptors(o.allowCredentials);
  if (allow) out.allowCredentials = allow;
  return out;
}

/* ── credential: native → JSON ── */

interface CredentialLike {
  id: string;
  rawId: ArrayBuffer;
  type: string;
  authenticatorAttachment?: string | null;
  response: AuthenticatorResponse;
  getClientExtensionResults?: () => AuthenticationExtensionsClientOutputs;
  toJSON?: () => unknown;
}

/** Manual `PublicKeyCredential.toJSON()` for attestation (create) and assertion (get) responses. */
export function credentialToJSON(cred: CredentialLike): Json {
  const r = cred.response as AuthenticatorResponse & Partial<AuthenticatorAttestationResponse & AuthenticatorAssertionResponse>;
  const response: Json = { clientDataJSON: bufferToBase64url(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = bufferToBase64url(r.attestationObject);
    if (typeof r.getTransports === "function") response.transports = r.getTransports();
    if (typeof r.getAuthenticatorData === "function") response.authenticatorData = bufferToBase64url(r.getAuthenticatorData());
    if (typeof r.getPublicKeyAlgorithm === "function") response.publicKeyAlgorithm = r.getPublicKeyAlgorithm();
    const pk = typeof r.getPublicKey === "function" ? r.getPublicKey() : null;
    if (pk) response.publicKey = bufferToBase64url(pk);
  } else {
    if (r.authenticatorData) response.authenticatorData = bufferToBase64url(r.authenticatorData);
    if (r.signature) response.signature = bufferToBase64url(r.signature);
    response.userHandle = r.userHandle ? bufferToBase64url(r.userHandle) : null;
  }
  const out: Json = {
    id: cred.id,
    rawId: bufferToBase64url(cred.rawId),
    type: cred.type,
    response,
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
  };
  if (cred.authenticatorAttachment) out.authenticatorAttachment = cred.authenticatorAttachment;
  return out;
}

function toJSON(cred: CredentialLike): unknown {
  if (typeof cred.toJSON === "function") {
    try {
      return cred.toJSON();
    } catch {
      /* some password-manager extensions return objects whose toJSON throws */
    }
  }
  return credentialToJSON(cred);
}

/* ── ceremonies ── */

interface PKCStatics {
  parseCreationOptionsFromJSON?: (o: unknown) => PublicKeyCredentialCreationOptions;
  parseRequestOptionsFromJSON?: (o: unknown) => PublicKeyCredentialRequestOptions;
}

const statics = (): PKCStatics | undefined =>
  typeof window !== "undefined" ? (window.PublicKeyCredential as unknown as PKCStatics | undefined) : undefined;

/** True when the browser can do WebAuthn at all (the address may still rule it out: https + domain). */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && !!navigator.credentials?.create;
}

/** Registration: runs `navigator.credentials.create` and returns the credential JSON for the server. */
export async function createPasskey(publicKey: unknown): Promise<unknown> {
  const parse = statics()?.parseCreationOptionsFromJSON;
  const options = parse ? parse(unwrap(publicKey)) : creationOptionsFromJSON(publicKey);
  const cred = await navigator.credentials.create({ publicKey: options });
  if (!cred) throw new DOMException("Passkey не создан", "NotAllowedError");
  return toJSON(cred as unknown as CredentialLike);
}

/** Login: runs `navigator.credentials.get` and returns the assertion JSON for the server. */
export async function getPasskey(publicKey: unknown): Promise<unknown> {
  const parse = statics()?.parseRequestOptionsFromJSON;
  const options = parse ? parse(unwrap(publicKey)) : requestOptionsFromJSON(publicKey);
  const cred = await navigator.credentials.get({ publicKey: options });
  if (!cred) throw new DOMException("Вход отменён", "NotAllowedError");
  return toJSON(cred as unknown as CredentialLike);
}

/**
 * Russian text for an error of the browser side of a ceremony; null when the user simply
 * cancelled (NotAllowedError / AbortError: show nothing).
 */
export function webauthnErrorText(err: unknown): string | null | undefined {
  if (!(err instanceof DOMException) && !(err instanceof Error)) return undefined;
  switch (err.name) {
    case "NotAllowedError":
    case "AbortError":
      return null;
    case "InvalidStateError":
      return "Этот passkey уже добавлен";
    case "SecurityError":
      return "Браузер запретил passkey для этого адреса: нужен https и доменное имя";
    case "NotSupportedError":
      return "Это устройство не поддерживает такие passkey";
    default:
      return undefined;
  }
}
