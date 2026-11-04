package oidc

import (
	"context"
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---- test signer ----

type hmacSigner struct{ key []byte }

func (s hmacSigner) Sign(payload []byte) string {
	m := hmac.New(sha256.New, s.key)
	m.Write(payload)
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (s hmacSigner) Verify(token string) ([]byte, bool) {
	p, sig, ok := strings.Cut(token, ".")
	if !ok {
		return nil, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(p)
	if err != nil {
		return nil, false
	}
	got, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil {
		return nil, false
	}
	m := hmac.New(sha256.New, s.key)
	m.Write(payload)
	if !hmac.Equal(got, m.Sum(nil)) {
		return nil, false
	}
	return payload, true
}

var testSigner = hmacSigner{key: []byte("test-key-0123456789")}

// ---- fake IdP ----

type grant struct {
	challenge string
	claims    map[string]any
}

type fakeIdP struct {
	t        *testing.T
	srv      *httptest.Server
	key      *rsa.PrivateKey
	signWith *rsa.PrivateKey
	kid      string
	mu       sync.Mutex
	grants   map[string]grant
}

func newFakeIdP(t *testing.T) *fakeIdP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	idp := &fakeIdP{t: t, key: key, kid: "k1", grants: map[string]grant{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"issuer":                                idp.issuer(),
			"authorization_endpoint":                idp.issuer() + "/authorize",
			"token_endpoint":                        idp.issuer() + "/token",
			"jwks_uri":                              idp.issuer() + "/jwks",
			"response_types_supported":              []string{"code"},
			"subject_types_supported":               []string{"public"},
			"id_token_signing_alg_values_supported": []string{"RS256"},
			"code_challenge_methods_supported":      []string{"S256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		pub := idp.key.PublicKey
		writeJSON(w, 200, map[string]any{"keys": []map[string]any{{
			"kty": "RSA", "alg": "RS256", "use": "sig", "kid": idp.kid,
			"n": b64(pub.N.Bytes()),
			"e": b64(big.NewInt(int64(pub.E)).Bytes()),
		}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method", 405)
			return
		}
		if err := r.ParseForm(); err != nil {
			http.Error(w, "form", 400)
			return
		}
		code := r.PostForm.Get("code")
		idp.mu.Lock()
		g, ok := idp.grants[code]
		delete(idp.grants, code)
		idp.mu.Unlock()
		if !ok || r.PostForm.Get("grant_type") != "authorization_code" {
			writeJSON(w, 400, map[string]any{"error": "invalid_grant"})
			return
		}
		sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
		if b64(sum[:]) != g.challenge {
			writeJSON(w, 400, map[string]any{"error": "invalid_grant", "error_description": "pkce"})
			return
		}
		writeJSON(w, 200, map[string]any{
			"access_token": "at",
			"token_type":   "Bearer",
			"expires_in":   3600,
			"id_token":     idp.sign(g.claims),
		})
	})
	idp.srv = httptest.NewServer(mux)
	t.Cleanup(idp.srv.Close)
	return idp
}

func (idp *fakeIdP) issuer() string { return idp.srv.URL }

func (idp *fakeIdP) issue(code, challenge string, claims map[string]any) {
	idp.mu.Lock()
	defer idp.mu.Unlock()
	idp.grants[code] = grant{challenge: challenge, claims: claims}
}

// sign builds an RS256 JWS by hand.
func (idp *fakeIdP) sign(claims map[string]any) string {
	h, _ := json.Marshal(map[string]any{"alg": "RS256", "typ": "JWT", "kid": idp.kid})
	c, _ := json.Marshal(claims)
	in := b64(h) + "." + b64(c)
	sum := sha256.Sum256([]byte(in))
	key := idp.key
	if idp.signWith != nil {
		key = idp.signWith
	}
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		idp.t.Fatal(err)
	}
	return in + "." + b64(sig)
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// ---- helpers ----

const testClientID = "jui-client"

func testConfig(idp *fakeIdP) Config {
	return Config{
		Issuer:       idp.issuer(),
		ClientID:     testClientID,
		ClientSecret: "secret",
		RedirectURL:  "https://jackett.example.com/_ui/auth/oidc/callback",
	}
}

func mustNew(t *testing.T, cfg Config) *Provider {
	t.Helper()
	p, err := New(context.Background(), cfg, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return p
}

type started struct {
	cookie    *http.Cookie
	state     string
	nonce     string
	challenge string
	authURL   *url.URL
}

func start(t *testing.T, p *Provider, returnPath, testToken string, secure bool) started {
	t.Helper()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/_ui/auth/oidc/start", nil)
	raw, err := p.Start(w, r, testSigner, returnPath, testToken, secure)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	var c *http.Cookie
	for _, ck := range w.Result().Cookies() {
		if ck.Name == FlowCookie {
			c = ck
		}
	}
	if c == nil {
		t.Fatal("Start set no flow cookie")
	}
	q := u.Query()
	return started{cookie: c, state: q.Get("state"), nonce: q.Get("nonce"), challenge: q.Get("code_challenge"), authURL: u}
}

func baseClaims(idp *fakeIdP, nonce string) map[string]any {
	n := time.Now()
	return map[string]any{
		"iss":            idp.issuer(),
		"sub":            "user-123",
		"aud":            testClientID,
		"iat":            n.Unix(),
		"exp":            n.Add(5 * time.Minute).Unix(),
		"nonce":          nonce,
		"email":          "Alice@Example.com",
		"email_verified": true,
		"groups":         []string{"users", "Media"},
	}
}

func callback(t *testing.T, p *Provider, cookie *http.Cookie, query string, secure bool) (Result, error, *httptest.ResponseRecorder) {
	t.Helper()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/_ui/auth/oidc/callback?"+query, nil)
	if cookie != nil {
		r.AddCookie(&http.Cookie{Name: cookie.Name, Value: cookie.Value})
	}
	res, err := p.Finish(w, r, testSigner, secure)
	return res, err, w
}

// login runs a complete flow; mutate may change the claims the IdP signs.
func login(t *testing.T, idp *fakeIdP, p *Provider, mutate func(map[string]any)) (Result, error, *httptest.ResponseRecorder) {
	t.Helper()
	s := start(t, p, "/search?q=1", "", false)
	claims := baseClaims(idp, s.nonce)
	if mutate != nil {
		mutate(claims)
	}
	idp.issue("code1", s.challenge, claims)
	return callback(t, p, s.cookie, url.Values{"code": {"code1"}, "state": {s.state}}.Encode(), false)
}

func assertCleared(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	for _, c := range w.Result().Cookies() {
		if c.Name == FlowCookie {
			if c.MaxAge >= 0 || c.Value != "" || c.Path != "/_ui/auth/" {
				t.Fatalf("flow cookie not cleared properly: %+v", c)
			}
			return
		}
	}
	t.Fatal("Finish did not clear the flow cookie")
}

func wantErr(t *testing.T, err, target error) {
	t.Helper()
	if !errors.Is(err, target) {
		t.Fatalf("error = %v, want %v", err, target)
	}
}

// ---- tests ----

func TestHappyPath(t *testing.T) {
	idp := newFakeIdP(t)
	p := mustNew(t, testConfig(idp))
	s := start(t, p, "/indexers?x=1", "tok-42", false)

	q := s.authURL.Query()
	if !strings.HasPrefix(s.authURL.String(), idp.issuer()+"/authorize?") {
		t.Fatalf("auth URL = %s", s.authURL)
	}
	if q.Get("code_challenge_method") != "S256" || q.Get("client_id") != testClientID ||
		q.Get("response_type") != "code" || q.Get("redirect_uri") != testConfig(idp).RedirectURL {
		t.Fatalf("auth URL params: %v", q)
	}
	if q.Get("scope") != "openid email profile" {
		t.Fatalf("scope = %q", q.Get("scope"))
	}
	for name, v := range map[string]string{"state": s.state, "nonce": s.nonce, "challenge": s.challenge} {
		if b, err := base64.RawURLEncoding.DecodeString(v); err != nil || len(b) < 32 {
			t.Fatalf("%s %q is not >=32 random bytes", name, v)
		}
	}
	if s.state == s.nonce {
		t.Fatal("state == nonce")
	}

	idp.issue("c", s.challenge, baseClaims(idp, s.nonce))
	res, err, w := callback(t, p, s.cookie, "code=c&state="+url.QueryEscape(s.state), false)
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if res.Identity.User != "Alice@Example.com" || res.Identity.Email != "Alice@Example.com" {
		t.Fatalf("identity = %+v", res.Identity)
	}
	if id := res.Identity; id.Subject != "user-123" || id.Issuer != idp.issuer() || !id.EmailVerified || !id.EmailVerifiedPresent || !id.EmailUsable(false) {
		t.Fatalf("subject/issuer/verified = %+v", id)
	}
	if strings.Join(res.Identity.Groups, ",") != "users,Media" {
		t.Fatalf("groups = %v", res.Identity.Groups)
	}
	if res.ReturnPath != "/indexers?x=1" || res.TestToken != "tok-42" {
		t.Fatalf("result = %+v", res)
	}
	assertCleared(t, w)

	// The flow can't be replayed: the code is single-use at the IdP, and
	// the cookie is gone on the client side.
	if _, err, _ := callback(t, p, nil, "code=c&state="+url.QueryEscape(s.state), false); !errors.Is(err, ErrState) {
		t.Fatalf("replay without cookie: %v", err)
	}
}

func TestUserFallbacks(t *testing.T) {
	idp := newFakeIdP(t)
	p := mustNew(t, testConfig(idp))
	res, err, _ := login(t, idp, p, func(c map[string]any) {
		delete(c, "email")
		delete(c, "email_verified")
		c["preferred_username"] = "alice"
	})
	if err != nil || res.Identity.User != "alice" || res.Identity.Email != "" {
		t.Fatalf("preferred_username: %+v %v", res, err)
	}
	res, err, _ = login(t, idp, p, func(c map[string]any) {
		delete(c, "email")
		delete(c, "groups")
	})
	if err != nil || res.Identity.User != "user-123" || res.Identity.Groups != nil {
		t.Fatalf("sub: %+v %v", res, err)
	}
	// Profile claims and email_verified variants.
	res, err, _ = login(t, idp, p, func(c map[string]any) {
		c["name"] = " Alice A. "
		c["preferred_username"] = "alice"
		delete(c, "email_verified")
	})
	if id := res.Identity; err != nil || id.Name != "Alice A." || id.PreferredUsername != "alice" || id.EmailVerifiedPresent || !id.EmailUsable(false) {
		t.Fatalf("profile: %+v %v", res.Identity, err)
	}
	unverified := Identity{Email: "a@b", EmailVerifiedPresent: true}
	if unverified.EmailUsable(false) || !unverified.EmailUsable(true) || (Identity{}).EmailUsable(true) {
		t.Fatal("EmailUsable")
	}
}

func TestStateMismatch(t *testing.T) {
	idp := newFakeIdP(t)
	p := mustNew(t, testConfig(idp))
	s := start(t, p, "/", "", false)
	idp.issue("c", s.challenge, baseClaims(idp, s.nonce))
	_, err, w := callback(t, p, s.cookie, "code=c&state=wrong", false)
	wantErr(t, err, ErrState)
	assertCleared(t, w)
	_, err, _ = callback(t, p, s.cookie, "code=c", false)
	wantErr(t, err, ErrState)
}

func TestIssParamMismatch(t *testing.T) {
	idp := newFakeIdP(t)
	p := mustNew(t, testConfig(idp))
	s := start(t, p, "/", "", false)
	_, err, _ := callback(t, p, s.cookie, url.Values{"code": {"c"}, "state": {s.state}, "iss": {"https://evil"}}.Encode(), false)
	wantErr(t, err, ErrState)
}

func TestMissingCookie(t *testing.T) {
	idp := newFakeIdP(t)
	p := mustNew(t, testConfig(idp))
	_, err, w := callback(t, p, nil, "code=c&state=x", false)
	wantErr(t, err, ErrState)
	assertCleared(t, w)
}

func TestTamperedCookie(t *testing.T) {
	idp := newFakeIdP(t)
	p := mustNew(t, testConfig(idp))
	s := start(t, p, "/", "", false)
	payload, sig, _ := strings.Cut(s.cookie.Value, ".")
	raw, _ := base64.RawURLEncoding.DecodeString(payload)
	raw = []byte(strings.Replace(string(raw), `"r":"/"`, `"r":"/x"`, 1))
	bad := &http.Cookie{Name: FlowCookie, Value: b64(raw) + "." + sig}
	_, err, _ := callback(t, p, bad, "code=c&state="+url.QueryEscape(s.state), false)
	wantErr(t, err, ErrState)

	// Garbage that is validly signed but not a flow.
	junk := &http.Cookie{Name: FlowCookie, Value: testSigner.Sign([]byte(`{"x":1}`))}
	_, err, _ = callback(t, p, junk, "code=c&state=", false)
	wantErr(t, err, ErrState)
}

func TestCookieFromOtherProvider(t *testing.T) {
	idp := newFakeIdP(t)
	p1 := mustNew(t, testConfig(idp))
	cfg2 := testConfig(idp)
	cfg2.ClientID = "other"
	p2 := mustNew(t, cfg2)
	s := start(t, p1, "/", "", false)
	_, err, _ := callback(t, p2, s.cookie, "code=c&state="+url.QueryEscape(s.state), false)
	wantErr(t, err, ErrState)
}

func TestExpiredFlow(t *testing.T) {
	idp := newFakeIdP(t)
	p := mustNew(t, testConfig(idp))
	s := start(t, p, "/", "", false)
	orig := now
	now = func() time.Time { return orig().Add(FlowTTL + time.Second) }
	defer func() { now = orig }()
	_, err, w := callback(t, p, s.cookie, "code=c&state="+url.QueryEscape(s.state), false)
	wantErr(t, err, ErrFlowExpired)
	assertCleared(t, w)
}

func TestWrongNonce(t *testing.T) {
	idp := newFakeIdP(t)
	p := mustNew(t, testConfig(idp))
	_, err, w := login(t, idp, p, func(c map[string]any) { c["nonce"] = "other" })
	wantErr(t, err, ErrNonce)
	assertCleared(t, w)
	_, err, _ = login(t, idp, p, func(c map[string]any) { delete(c, "nonce") })
	wantErr(t, err, ErrNonce)
}

func TestWrongAudience(t *testing.T) {
	idp := newFakeIdP(t)
	p := mustNew(t, testConfig(idp))
	_, err, _ := login(t, idp, p, func(c map[string]any) { c["aud"] = "someone-else" })
	wantErr(t, err, ErrToken)
}

func TestWrongIssuerClaim(t *testing.T) {
	idp := newFakeIdP(t)
	p := mustNew(t, testConfig(idp))
	_, err, _ := login(t, idp, p, func(c map[string]any) { c["iss"] = "https://evil.example" })
	wantErr(t, err, ErrToken)
}

func TestExpiredToken(t *testing.T) {
	idp := newFakeIdP(t)
	p := mustNew(t, testConfig(idp))
	_, err, _ := login(t, idp, p, func(c map[string]any) {
		c["iat"] = time.Now().Add(-2 * time.Hour).Unix()
		c["exp"] = time.Now().Add(-time.Hour).Unix()
	})
	wantErr(t, err, ErrToken)
}

func TestBadSignature(t *testing.T) {
	idp := newFakeIdP(t)
	p := mustNew(t, testConfig(idp))
	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	idp.signWith = other // not in the JWKS
	_, err, _ = login(t, idp, p, nil)
	wantErr(t, err, ErrToken)
}

func TestPKCEMismatch(t *testing.T) {
	idp := newFakeIdP(t)
	p := mustNew(t, testConfig(idp))
	s := start(t, p, "/", "", false)
	// The IdP remembers a different challenge than the one for our verifier.
	idp.issue("c", b64(make([]byte, 32)), baseClaims(idp, s.nonce))
	_, err, w := callback(t, p, s.cookie, "code=c&state="+url.QueryEscape(s.state), false)
	wantErr(t, err, ErrExchange)
	assertCleared(t, w)
}

func TestUnknownCode(t *testing.T) {
	idp := newFakeIdP(t)
	p := mustNew(t, testConfig(idp))
	s := start(t, p, "/", "", false)
	_, err, _ := callback(t, p, s.cookie, "code=nope&state="+url.QueryEscape(s.state), false)
	wantErr(t, err, ErrExchange)
	_, err, _ = callback(t, p, s.cookie, "state="+url.QueryEscape(s.state), false)
	wantErr(t, err, ErrExchange)
}

func TestIdPError(t *testing.T) {
	idp := newFakeIdP(t)
	p := mustNew(t, testConfig(idp))
	s := start(t, p, "/", "", false)
	_, err, w := callback(t, p, s.cookie, "error=access_denied&error_description=nope&state="+url.QueryEscape(s.state), false)
	wantErr(t, err, ErrIdP)
	assertCleared(t, w)
}

func TestAllowLists(t *testing.T) {
	tests := []struct {
		name   string
		emails []string
		groups []string
		mutate func(map[string]any)
		ok     bool
	}{
		{"no lists", nil, nil, nil, true},
		{"email allowed, case-insensitive", []string{"alice@example.COM"}, nil, nil, true},
		{"email denied", []string{"bob@example.com"}, nil, nil, false},
		{"group allowed via array", nil, []string{"MEDIA"}, nil, true},
		{"group allowed via string", nil, []string{"admins"}, func(c map[string]any) { c["groups"] = "Admins" }, true},
		{"group denied", nil, []string{"admins"}, nil, false},
		{"no groups claim", nil, []string{"users"}, func(c map[string]any) { delete(c, "groups") }, false},
		{"both lists, email matches", []string{"alice@example.com"}, []string{"admins"}, nil, true},
		{"both lists, group matches", []string{"bob@example.com"}, []string{"users"}, nil, true},
		{"both lists, none matches", []string{"bob@example.com"}, []string{"admins"}, nil, false},
		{"email_verified false", []string{"alice@example.com"}, nil, func(c map[string]any) { c["email_verified"] = false }, false},
		{"email_verified \"false\" string", []string{"alice@example.com"}, nil, func(c map[string]any) { c["email_verified"] = "false" }, false},
		{"email_verified \"true\" string", []string{"alice@example.com"}, nil, func(c map[string]any) { c["email_verified"] = "true" }, true},
		{"email_verified absent", []string{"alice@example.com"}, nil, func(c map[string]any) { delete(c, "email_verified") }, true},
		{"email_verified false, group still matches", []string{"alice@example.com"}, []string{"users"}, func(c map[string]any) { c["email_verified"] = false }, true},
		{"email_verified false, no allow-list", nil, nil, func(c map[string]any) { c["email_verified"] = false }, true},
		{"group list does not match username", nil, []string{"alice@example.com"}, nil, false},
	}
	idp := newFakeIdP(t)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := testConfig(idp)
			cfg.AllowedEmails = tt.emails
			cfg.AllowedGroups = tt.groups
			p := mustNew(t, cfg)
			_, err, w := login(t, idp, p, tt.mutate)
			if tt.ok && err != nil {
				t.Fatalf("want ok, got %v", err)
			}
			if !tt.ok {
				wantErr(t, err, ErrNotAllowed)
			}
			assertCleared(t, w)
		})
	}
}

func TestCustomGroupsClaim(t *testing.T) {
	idp := newFakeIdP(t)
	cfg := testConfig(idp)
	cfg.GroupsClaim = "roles"
	cfg.AllowedGroups = []string{"jackett"}
	p := mustNew(t, cfg)
	res, err, _ := login(t, idp, p, func(c map[string]any) { c["roles"] = []string{"jackett"} })
	if err != nil || len(res.Identity.Groups) != 1 {
		t.Fatalf("%+v %v", res, err)
	}
}

func TestSanitizeReturnPath(t *testing.T) {
	tests := map[string]string{
		"/ok":               "/ok",
		"/ok?a=b#c":         "/ok?a=b#c",
		"/":                 "/",
		"//evil":            "/",
		"//evil.com/x":      "/",
		`/\evil`:            "/",
		`/a\b`:              "/",
		"https://evil":      "/",
		"javascript:alert1": "/",
		"":                  "/",
		"ok":                "/",
		"/a\r\nX: y":        "/",
		"/\tx":              "/",
	}
	for in, want := range tests {
		if got := SanitizeReturnPath(in); got != want {
			t.Errorf("SanitizeReturnPath(%q) = %q, want %q", in, got, want)
		}
	}
	// End to end: Start stores the sanitized value.
	idp := newFakeIdP(t)
	p := mustNew(t, testConfig(idp))
	for in, want := range tests {
		s := start(t, p, in, "", false)
		idp.issue("c", s.challenge, baseClaims(idp, s.nonce))
		res, err, _ := callback(t, p, s.cookie, "code=c&state="+url.QueryEscape(s.state), false)
		if err != nil || res.ReturnPath != want {
			t.Errorf("return %q: got %q, %v", in, res.ReturnPath, err)
		}
	}
}

func TestCookieAttributes(t *testing.T) {
	idp := newFakeIdP(t)
	p := mustNew(t, testConfig(idp))
	for _, secure := range []bool{false, true} {
		s := start(t, p, "/", "", secure)
		c := s.cookie
		if c.Secure != secure || !c.HttpOnly || c.SameSite != http.SameSiteLaxMode ||
			c.Path != "/_ui/auth/" || c.MaxAge != int(FlowTTL/time.Second) {
			t.Fatalf("secure=%v cookie = %+v", secure, c)
		}
		_, _, w := callback(t, p, c, "state=x", secure)
		for _, ck := range w.Result().Cookies() {
			if ck.Name == FlowCookie && (ck.Secure != secure || !ck.HttpOnly || ck.SameSite != http.SameSiteLaxMode) {
				t.Fatalf("clear cookie attrs: %+v", ck)
			}
		}
	}
}

func TestFlowTestToken(t *testing.T) {
	idp := newFakeIdP(t)
	p := mustNew(t, testConfig(idp))
	s := start(t, p, "/", "tok-7", false)
	r := httptest.NewRequest("GET", "/_ui/auth/oidc/callback", nil)
	r.AddCookie(&http.Cookie{Name: FlowCookie, Value: s.cookie.Value})
	if got := FlowTestToken(r, testSigner); got != "tok-7" {
		t.Fatalf("FlowTestToken = %q", got)
	}
	if got := FlowTestToken(httptest.NewRequest("GET", "/", nil), testSigner); got != "" {
		t.Fatalf("no cookie: %q", got)
	}
	s = start(t, p, "/profile?x=1", "link:u_1", false)
	r = httptest.NewRequest("GET", "/_ui/auth/oidc/callback", nil)
	r.AddCookie(&http.Cookie{Name: FlowCookie, Value: s.cookie.Value})
	if tok, ret, ok := FlowInfo(r, testSigner); !ok || tok != "link:u_1" || ret != "/profile?x=1" {
		t.Fatalf("FlowInfo = %q %q %v", tok, ret, ok)
	}
	if _, _, ok := FlowInfo(httptest.NewRequest("GET", "/", nil), testSigner); ok {
		t.Fatal("FlowInfo without cookie")
	}
}

func TestNewValidation(t *testing.T) {
	idp := newFakeIdP(t)
	base := testConfig(idp)
	bad := []func(*Config){
		func(c *Config) { c.Issuer = "" },
		func(c *Config) { c.Issuer = "not a url" },
		func(c *Config) { c.ClientID = "" },
		func(c *Config) { c.RedirectURL = "" },
		func(c *Config) { c.RedirectURL = "/_ui/auth/oidc/callback" },
		func(c *Config) { c.RedirectURL = "ftp://x/cb" },
	}
	for i, m := range bad {
		cfg := base
		m(&cfg)
		if _, err := New(context.Background(), cfg, nil); !errors.Is(err, ErrNotConfigured) {
			t.Errorf("case %d: err = %v", i, err)
		}
	}
	// Public client (no secret), custom scopes without openid.
	cfg := base
	cfg.ClientSecret = ""
	cfg.Scopes = []string{"email", "groups email"}
	p := mustNew(t, cfg)
	if got := strings.Join(p.Config().Scopes, " "); got != "openid email groups" {
		t.Fatalf("scopes = %q", got)
	}
	if p.Config().GroupsClaim != "groups" {
		t.Fatalf("groups claim = %q", p.Config().GroupsClaim)
	}
	res, err, _ := login(t, idp, p, nil)
	if err != nil || res.Identity.User == "" {
		t.Fatalf("public client login: %v", err)
	}
}

func TestDiscoveryFailure(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	cfg := Config{Issuer: srv.URL, ClientID: "x", RedirectURL: "https://a/cb"}
	if _, err := New(context.Background(), cfg, srv.Client()); err == nil {
		t.Fatal("want discovery error")
	}
	// Issuer in the document differs from the configured one.
	idp := newFakeIdP(t)
	cfg = testConfig(idp)
	cfg.Issuer = idp.issuer() + "/"
	if _, err := New(context.Background(), cfg, nil); err == nil {
		t.Fatal("want issuer mismatch error")
	}
}

// AllowUnverifiedEmail lets email_verified=false match the e-mail allow-list (own IdP, e.g. Authentik).
func TestAllowUnverifiedEmail(t *testing.T) {
	for _, allow := range []bool{false, true} {
		idp := newFakeIdP(t)
		cfg := testConfig(idp)
		cfg.AllowedEmails = []string{"user@example.com"}
		cfg.AllowedGroups = nil
		cfg.AllowUnverifiedEmail = allow
		p := mustNew(t, cfg)
		_, err, _ := login(t, idp, p, func(c map[string]any) {
			c["email"] = "user@example.com"
			c["email_verified"] = false
			delete(c, "groups")
		})
		if allow && err != nil {
			t.Errorf("allow=true: %v", err)
		}
		if !allow && !errors.Is(err, ErrNotAllowed) {
			t.Errorf("allow=false: err = %v, want ErrNotAllowed", err)
		}
	}
}
