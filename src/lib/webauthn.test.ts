import { afterEach, describe, expect, it, vi } from "vitest";

import {
  base64urlToBuffer,
  bufferToBase64url,
  createPasskey,
  creationOptionsFromJSON,
  credentialToJSON,
  getPasskey,
  passkeysSupported,
  requestOptionsFromJSON,
  webauthnErrorText,
} from "@/lib/webauthn";

const bytes = (b: ArrayBuffer | BufferSource) => Array.from(new Uint8Array(b as ArrayBuffer));
const buf = (...b: number[]) => new Uint8Array(b).buffer;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("base64url", () => {
  it("encodes without padding and with the url alphabet", () => {
    expect(bufferToBase64url(buf(0xfb, 0xff, 0xfe))).toBe("-__-");
    expect(bufferToBase64url(buf(1))).toBe("AQ");
    expect(bufferToBase64url(buf(1, 2))).toBe("AQI");
    expect(bufferToBase64url(new Uint8Array([9, 1, 2, 3]).subarray(1))).toBe("AQID");
    expect(bufferToBase64url(buf())).toBe("");
  });

  it("decodes with or without padding", () => {
    expect(bytes(base64urlToBuffer("-__-"))).toEqual([0xfb, 0xff, 0xfe]);
    expect(bytes(base64urlToBuffer("AQ"))).toEqual([1]);
    expect(bytes(base64urlToBuffer("AQ=="))).toEqual([1]);
    expect(bytes(base64urlToBuffer(""))).toEqual([]);
  });

  it("round-trips every byte value", () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(bytes(base64urlToBuffer(bufferToBase64url(all)))).toEqual(Array.from(all));
  });
});

const creationJSON = {
  rp: { name: "Jackett", id: "jackett.example.com" },
  user: { id: "AQID", name: "admin", displayName: "Админ" },
  challenge: "BAUG",
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  timeout: 300000,
  excludeCredentials: [{ type: "public-key", id: "Bwg", transports: ["internal"] }],
  authenticatorSelection: { residentKey: "required", userVerification: "required" },
};

describe("options from JSON (manual)", () => {
  it("converts creation options", () => {
    const o = creationOptionsFromJSON(creationJSON);
    expect(bytes(o.challenge as ArrayBuffer)).toEqual([4, 5, 6]);
    expect(bytes(o.user.id as ArrayBuffer)).toEqual([1, 2, 3]);
    expect(o.user.name).toBe("admin");
    expect(o.rp.id).toBe("jackett.example.com");
    expect(o.excludeCredentials?.[0]?.transports).toEqual(["internal"]);
    expect(bytes(o.excludeCredentials![0]!.id as ArrayBuffer)).toEqual([7, 8]);
    expect(o.authenticatorSelection?.residentKey).toBe("required");
  });

  it("accepts go-webauthn's {publicKey: …} wrapper", () => {
    const o = creationOptionsFromJSON({ publicKey: creationJSON });
    expect(bytes(o.challenge as ArrayBuffer)).toEqual([4, 5, 6]);
  });

  it("converts request options; no allowCredentials stays absent (discoverable login)", () => {
    const o = requestOptionsFromJSON({ challenge: "BAUG", rpId: "jackett.example.com", userVerification: "required" });
    expect(bytes(o.challenge as ArrayBuffer)).toEqual([4, 5, 6]);
    expect(o.rpId).toBe("jackett.example.com");
    expect(o.allowCredentials).toBeUndefined();
    const withAllow = requestOptionsFromJSON({ challenge: "AA", allowCredentials: [{ type: "public-key", id: "Bwg" }] });
    expect(bytes(withAllow.allowCredentials![0]!.id as ArrayBuffer)).toEqual([7, 8]);
  });
});

function attestationCredential() {
  return {
    id: "Bwg",
    rawId: buf(7, 8),
    type: "public-key",
    authenticatorAttachment: "platform",
    response: { clientDataJSON: buf(1), attestationObject: buf(2), getTransports: () => ["internal", "hybrid"] },
    getClientExtensionResults: () => ({ credProps: { rk: true } }),
  };
}

function assertionCredential(userHandle: ArrayBuffer | null = buf(1, 2, 3)) {
  return {
    id: "Bwg",
    rawId: buf(7, 8),
    type: "public-key",
    authenticatorAttachment: null,
    response: { clientDataJSON: buf(1), authenticatorData: buf(3), signature: buf(4), userHandle },
    getClientExtensionResults: () => ({}),
  };
}

describe("credentialToJSON (manual)", () => {
  it("serializes an attestation", () => {
    expect(credentialToJSON(attestationCredential() as never)).toEqual({
      id: "Bwg",
      rawId: "Bwg",
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: { credProps: { rk: true } },
      response: { clientDataJSON: "AQ", attestationObject: "Ag", transports: ["internal", "hybrid"] },
    });
  });

  it("serializes an assertion", () => {
    expect(credentialToJSON(assertionCredential() as never)).toEqual({
      id: "Bwg",
      rawId: "Bwg",
      type: "public-key",
      clientExtensionResults: {},
      response: { clientDataJSON: "AQ", authenticatorData: "Aw", signature: "BA", userHandle: "AQID" },
    });
    expect((credentialToJSON(assertionCredential(null) as never).response as Record<string, unknown>).userHandle).toBeNull();
  });
});

describe("ceremonies", () => {
  it("createPasskey falls back to manual conversion without the native helpers", async () => {
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    const create = vi.fn().mockResolvedValue(attestationCredential());
    vi.stubGlobal("navigator", { ...navigator, credentials: { create, get: vi.fn() } });
    expect(passkeysSupported()).toBe(true);

    const json = (await createPasskey(creationJSON)) as Record<string, unknown>;
    const opts = create.mock.calls[0]![0].publicKey as PublicKeyCredentialCreationOptions;
    expect(bytes(opts.challenge as ArrayBuffer)).toEqual([4, 5, 6]);
    expect(json.rawId).toBe("Bwg");
  });

  it("uses parseRequestOptionsFromJSON and toJSON when present", async () => {
    const parsed = { challenge: buf(9) };
    const parse = vi.fn().mockReturnValue(parsed);
    vi.stubGlobal("PublicKeyCredential", Object.assign(function PublicKeyCredential() {}, { parseRequestOptionsFromJSON: parse }));
    const native = { ...assertionCredential(), toJSON: () => ({ native: true }) };
    const get = vi.fn().mockResolvedValue(native);
    vi.stubGlobal("navigator", { ...navigator, credentials: { create: vi.fn(), get } });

    expect(await getPasskey({ publicKey: { challenge: "CQ" } })).toEqual({ native: true });
    expect(parse).toHaveBeenCalledWith({ challenge: "CQ" });
    expect(get).toHaveBeenCalledWith({ publicKey: parsed });
  });

  it("reports no support without PublicKeyCredential", () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(passkeysSupported()).toBe(false);
  });
});

describe("webauthnErrorText", () => {
  it("is quiet when the user cancelled and explains the rest", () => {
    expect(webauthnErrorText(new DOMException("x", "NotAllowedError"))).toBeNull();
    expect(webauthnErrorText(new DOMException("x", "AbortError"))).toBeNull();
    expect(webauthnErrorText(new DOMException("x", "InvalidStateError"))).toMatch(/уже добавлен/);
    expect(webauthnErrorText(new DOMException("x", "SecurityError"))).toMatch(/https/);
    expect(webauthnErrorText(new Error("boom"))).toBeUndefined();
    expect(webauthnErrorText("boom")).toBeUndefined();
  });
});
