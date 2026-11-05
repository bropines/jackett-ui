package httpapi

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/fxamacker/cbor/v2"
)

const passkeyOrigin = "https://jackett.localhost"

// softKey is a minimal software authenticator ("none" attestation, ES256).
type softKey struct {
	t      *testing.T
	priv   *ecdsa.PrivateKey
	credID []byte
	handle []byte // user handle from registration
	rpID   string
	count  uint32
}

func newSoftKey(t *testing.T) *softKey {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id := make([]byte, 16)
	_, _ = rand.Read(id)
	return &softKey{t: t, priv: priv, credID: id}
}

func unb64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		t.Fatalf("base64url %q: %v", s, err)
	}
	return b
}

func clientData(typ, challenge string) []byte {
	b, _ := json.Marshal(map[string]any{"type": typ, "challenge": challenge, "origin": passkeyOrigin, "crossOrigin": false})
	return b
}

func (k *softKey) authData(flags byte, attested []byte) []byte {
	h := sha256.Sum256([]byte(k.rpID))
	out := append([]byte{}, h[:]...)
	out = append(out, flags)
	out = binary.BigEndian.AppendUint32(out, k.count)
	return append(out, attested...)
}

// create answers a registration "publicKey" options object.
func (k *softKey) create(opts map[string]any) map[string]any {
	k.t.Helper()
	k.rpID = opts["rp"].(map[string]any)["id"].(string)
	k.handle = unb64(k.t, opts["user"].(map[string]any)["id"].(string))
	x := k.priv.PublicKey.X.FillBytes(make([]byte, 32))
	y := k.priv.PublicKey.Y.FillBytes(make([]byte, 32))
	cose, err := cbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: x, -3: y})
	if err != nil {
		k.t.Fatal(err)
	}
	att := make([]byte, 16) // AAGUID
	att = binary.BigEndian.AppendUint16(att, uint16(len(k.credID)))
	att = append(att, k.credID...)
	att = append(att, cose...)
	ao, err := cbor.Marshal(map[string]any{"fmt": "none", "attStmt": map[string]any{}, "authData": k.authData(0x01|0x04|0x40, att)})
	if err != nil {
		k.t.Fatal(err)
	}
	cd := clientData("webauthn.create", opts["challenge"].(string))
	return map[string]any{
		"id": b64(k.credID), "rawId": b64(k.credID), "type": "public-key", "authenticatorAttachment": "platform",
		"response":               map[string]any{"clientDataJSON": b64(cd), "attestationObject": b64(ao), "transports": []string{"internal"}},
		"clientExtensionResults": map[string]any{},
	}
}

// get answers a login "publicKey" options object.
func (k *softKey) get(opts map[string]any) map[string]any {
	k.t.Helper()
	k.count++
	ad := k.authData(0x01|0x04, nil)
	cd := clientData("webauthn.get", opts["challenge"].(string))
	h := sha256.Sum256(cd)
	digest := sha256.Sum256(append(append([]byte{}, ad...), h[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, k.priv, digest[:])
	if err != nil {
		k.t.Fatal(err)
	}
	return map[string]any{
		"id": b64(k.credID), "rawId": b64(k.credID), "type": "public-key",
		"response":               map[string]any{"clientDataJSON": b64(cd), "authenticatorData": b64(ad), "signature": b64(sig), "userHandle": b64(k.handle)},
		"clientExtensionResults": map[string]any{},
	}
}

type ceremonyJSON struct {
	Ceremony  string         `json:"ceremony"`
	PublicKey map[string]any `json:"publicKey"`
}

func (h *harness) addPasskey(k *softKey, name string) passkeyView {
	h.t.Helper()
	w := h.do("POST", "/_ui/api/me/passkeys/begin", map[string]any{})
	h.expect(w, http.StatusOK)
	c := decode[ceremonyJSON](h.t, w)
	w = h.do("POST", "/_ui/api/me/passkeys/finish", map[string]any{"ceremony": c.Ceremony, "name": name, "credential": k.create(c.PublicKey)})
	h.expect(w, http.StatusCreated)
	return decode[passkeyView](h.t, w)
}

func (h *harness) passkeyLogin(k *softKey) *httptest.ResponseRecorder {
	h.t.Helper()
	w := h.do("POST", "/_ui/api/auth/passkey/begin", map[string]any{})
	h.expect(w, http.StatusOK)
	c := decode[ceremonyJSON](h.t, w)
	return h.do("POST", "/_ui/api/auth/passkey/finish", map[string]any{"ceremony": c.Ceremony, "credential": k.get(c.PublicKey)})
}

func TestPasskeyRP(t *testing.T) {
	cases := []struct{ origin, rp string }{
		{"https://jackett.example.com", "jackett.example.com"},
		{"https://Jackett.Example.com:8443", "jackett.example.com"},
		{"http://localhost:5173", "localhost"},
		{"http://app.localhost", "app.localhost"},
		{"http://jackett.example.com", ""},
		{"https://192.168.1.5", ""},
		{"https://[::1]", ""},
	}
	for _, c := range cases {
		rp, reason := passkeyRP(c.origin)
		if rp != c.rp || (c.rp == "") != (reason != "") {
			t.Errorf("%s: rp=%q reason=%q", c.origin, rp, reason)
		}
	}
}

func TestPasskeyRegisterAndLogin(t *testing.T) {
	h := newHarness(t, harnessOpt{env: map[string]string{"PUBLIC_URL": passkeyOrigin}})
	h.setup()

	// Not offered on the login page until someone has a passkey.
	if h.state().Methods.Passkey {
		t.Fatal("passkey offered without passkeys")
	}
	k := newSoftKey(t)
	pk := h.addPasskey(k, "Ноутбук")
	if pk.Name != "Ноутбук" || pk.ID == "" {
		t.Fatalf("passkey: %+v", pk)
	}
	list := decode[[]passkeyView](t, h.do("GET", "/_ui/api/me/passkeys", nil))
	if len(list) != 1 {
		t.Fatalf("list: %+v", list)
	}
	// The same authenticator can't be added twice (excluded / duplicate).
	if u := h.userByName("admin"); len(u.WebAuthnID) != 32 || len(u.Passkeys) != 1 {
		t.Fatalf("stored: %+v", u)
	}

	anon := h.clone()
	if !anon.state().Methods.Passkey {
		t.Fatal("passkey not offered")
	}
	w := anon.passkeyLogin(k)
	anon.expect(w, http.StatusNoContent)
	st := anon.state()
	if !st.Authenticated || st.User == nil || st.User.Username != "admin" {
		t.Fatalf("state after passkey login: %+v", st)
	}
	if u := h.userByName("admin"); u.Passkeys[0].LastUsedAt == nil || u.Passkeys[0].SignCount != 1 {
		t.Fatalf("usage not recorded: %+v", u.Passkeys[0])
	}

	// A replayed (non-advancing) counter is refused and flagged.
	k.count = 0
	w = h.clone().passkeyLogin(k)
	if w.Code != http.StatusUnauthorized || errorCode(w) != "passkey_invalid" {
		t.Fatalf("clone: %d %s", w.Code, w.Body.String())
	}
	if !h.userByName("admin").Passkeys[0].CloneWarning {
		t.Fatal("clone warning not stored")
	}

	// Unknown credential.
	w = h.clone().passkeyLogin(newSoftKey(t))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("unknown key: %d", w.Code)
	}

	// A ceremony is single use.
	c := decode[ceremonyJSON](t, anon.do("POST", "/_ui/api/auth/passkey/begin", map[string]any{}))
	anon.do("POST", "/_ui/api/auth/passkey/finish", map[string]any{"ceremony": c.Ceremony, "credential": map[string]any{}})
	k2 := *k
	k2.count = 100
	if w := anon.do("POST", "/_ui/api/auth/passkey/finish", map[string]any{"ceremony": c.Ceremony, "credential": k2.get(c.PublicKey)}); w.Code != http.StatusUnauthorized {
		t.Fatalf("reused ceremony: %d", w.Code)
	}

	// Rename and delete (the password still lets admin in).
	w2 := h.do("PATCH", "/_ui/api/me/passkeys/"+pk.ID, map[string]any{"name": "YubiKey"})
	h.expect(w2, http.StatusOK)
	if decode[passkeyView](t, w2).Name != "YubiKey" {
		t.Fatal("rename")
	}
	h.expect(h.do("DELETE", "/_ui/api/me/passkeys/"+pk.ID, nil, xhr), http.StatusNoContent)

	// Method off: no login.
	h.expect(h.put(map[string]any{"auth": map[string]any{"methods": map[string]any{"passkey": false}}}), http.StatusOK)
	if w := h.clone().do("POST", "/_ui/api/auth/passkey/begin", map[string]any{}); w.Code != http.StatusForbidden || errorCode(w) != "passkey_login_disabled" {
		t.Fatalf("method off: %d", w.Code)
	}
}

func TestPasskeyLockOutAndUnavailable(t *testing.T) {
	h := newHarness(t, harnessOpt{env: map[string]string{"PUBLIC_URL": passkeyOrigin}})
	h.setup()
	k := newSoftKey(t)
	pk := h.addPasskey(k, "")
	if pk.Name != defaultPasskeyName {
		t.Fatalf("default name: %q", pk.Name)
	}
	// Admin's password off → the passkey is the last way in.
	h.expect(h.do("PATCH", "/_ui/api/users/"+h.userByName("admin").ID, map[string]any{"password": nil}), http.StatusOK)
	if w := h.do("DELETE", "/_ui/api/me/passkeys/"+pk.ID, nil, xhr); w.Code != http.StatusConflict || errorCode(w) != "would_lock_out" {
		t.Fatalf("last passkey: %d %s", w.Code, w.Body.String())
	}

	// Plain http without PUBLIC_URL: unavailable, with a reason.
	p := newHarness(t, harnessOpt{})
	p.setup()
	if w := p.do("POST", "/_ui/api/me/passkeys/begin", map[string]any{}); w.Code != http.StatusConflict || errorCode(w) != "passkeys_unavailable" {
		t.Fatalf("unavailable: %d", w.Code)
	}
	var s struct {
		Auth struct {
			Passkey struct {
				Available bool   `json:"available"`
				Reason    string `json:"reason"`
			} `json:"passkey"`
		} `json:"auth"`
	}
	_ = json.Unmarshal(p.do("GET", "/_ui/api/settings", nil).Body.Bytes(), &s)
	if s.Auth.Passkey.Available || s.Auth.Passkey.Reason == "" {
		t.Fatalf("settings passkey: %+v", s.Auth.Passkey)
	}
}
