package httpapi

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/bropines/jackett-ui/server/internal/auth/github"
	"github.com/bropines/jackett-ui/server/internal/config"
	"github.com/bropines/jackett-ui/server/internal/jackett"
	"github.com/bropines/jackett-ui/server/internal/jackett/jackettfake"
	"github.com/bropines/jackett-ui/server/internal/proxy"
	"github.com/bropines/jackett-ui/server/internal/store"
)

const (
	testHost     = "ui.test"
	testRemote   = "192.0.2.10:4000" // untrusted client
	jackettPW    = "jackett-admin-pw"
	adminPW      = "admin-password-1"
	bigAssetSize = 8 << 10
)

var quietLog = slog.New(slog.NewTextHandler(io.Discard, nil))

type harness struct {
	t       *testing.T
	srv     *Server
	store   *store.Store
	jackett *jackettfake.Fake
	env     map[string]string
	jar     map[string]string // cookie name → value
	remote  string
	host    string
}

type harnessOpt struct {
	env      map[string]string
	settings func(*store.Settings)
	google   string // google issuer override
	github   github.Endpoints
}

func staticFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":          {Data: []byte("<!doctype html><html><body>jackett-ui index</body></html>")},
		"favicon.svg":         {Data: []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)},
		"assets/app-abc.js":   {Data: bytes.Repeat([]byte("console.log('jackett-ui');\n"), bigAssetSize/27+1)},
		"assets/small-1.css":  {Data: []byte("body{color:red}")},
		".secret":             {Data: []byte("hidden")},
		"assets/img/logo.png": {Data: []byte("\x89PNG....")},
	}
}

func newHarness(t *testing.T, o harnessOpt) *harness {
	t.Helper()
	jf := jackettfake.New(jackettPW)
	t.Cleanup(jf.Close)
	env := map[string]string{
		"JACKETT_URL":      jf.Server.URL,
		"JACKETT_PASSWORD": jackettPW,
		"DATA_DIR":         t.TempDir(),
	}
	for k, v := range o.env {
		env[k] = v
	}
	e, err := config.ParseEnv(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(e.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	if o.settings != nil {
		if err := st.Update(func(s *store.Settings) error { o.settings(s); return nil }); err != nil {
			t.Fatal(err)
		}
	}
	jc := jackett.New(e.JackettURL, e.JackettPassword, nil, quietLog)
	jc.FailBackoff = 0
	jc.StatusTTL = 0
	srv, err := New(Options{
		Env: e, Store: st, Jackett: jc, Proxy: proxy.New(jc, nil, quietLog), Static: staticFS(),
		Version: "test", Log: quietLog, GoogleIssuer: o.google, GitHubEndpoints: o.github,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Many logins from one test IP: the limiter has its own test.
	srv.limiter.PerMinute, srv.limiter.Burst = 1000, 1000
	return &harness{t: t, srv: srv, store: st, jackett: jf, env: env, jar: map[string]string{}, remote: testRemote, host: testHost}
}

// clone returns a second client (own cookie jar) for the same server.
func (h *harness) clone() *harness {
	c := *h
	c.jar = map[string]string{}
	return &c
}

type reqOpt func(*http.Request)

func hdr(k, v string) reqOpt { return func(r *http.Request) { r.Header.Set(k, v) } }

var xhr = hdr("X-Requested-With", "XMLHttpRequest")

func (h *harness) do(method, target string, body any, opts ...reqOpt) *httptest.ResponseRecorder {
	h.t.Helper()
	var rb io.Reader
	isJSON := false
	switch b := body.(type) {
	case nil:
	case string:
		rb = strings.NewReader(b)
	case []byte:
		rb = bytes.NewReader(b)
	default:
		j, _ := json.Marshal(b)
		rb = bytes.NewReader(j)
		isJSON = true
	}
	r := httptest.NewRequest(method, target, rb)
	r.Host = h.host
	r.RemoteAddr = h.remote
	if isJSON {
		r.Header.Set("Content-Type", "application/json")
	}
	for name, v := range h.jar {
		r.AddCookie(&http.Cookie{Name: name, Value: v})
	}
	for _, o := range opts {
		o(r)
	}
	w := httptest.NewRecorder()
	h.srv.ServeHTTP(w, r)
	for _, c := range w.Result().Cookies() {
		if c.MaxAge < 0 || c.Value == "" {
			delete(h.jar, c.Name)
		} else {
			h.jar[c.Name] = c.Value
		}
	}
	return w
}

func (h *harness) expect(w *httptest.ResponseRecorder, code int) {
	h.t.Helper()
	if w.Code != code {
		h.t.Fatalf("status %d, want %d; body: %s", w.Code, code, w.Body.String())
	}
}

func errorCode(w *httptest.ResponseRecorder) string {
	var b struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &b)
	return b.Error
}

func decode[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %s: %v", w.Body.String(), err)
	}
	return v
}

// setup runs the setup wizard and keeps the session.
func (h *harness) setup() {
	h.t.Helper()
	h.expect(h.do("POST", "/_ui/api/auth/setup", map[string]string{"password": adminPW}), http.StatusNoContent)
}

func (h *harness) login(pw string, opts ...reqOpt) *httptest.ResponseRecorder {
	return h.loginAs("admin", pw, opts...)
}

func (h *harness) state() stateResponse {
	h.t.Helper()
	w := h.do("GET", "/_ui/api/auth/state", nil)
	h.expect(w, 200)
	return decode[stateResponse](h.t, w)
}

func (h *harness) put(body any, opts ...reqOpt) *httptest.ResponseRecorder {
	if _, ok := body.(string); ok {
		opts = append([]reqOpt{hdr("Content-Type", "application/json")}, opts...)
	}
	return h.do("PUT", "/_ui/api/settings", body, opts...)
}

// ---- fake OIDC IdP (same shape as the oidc package's test fake) ----

type grant struct {
	challenge string
	claims    map[string]any
}

type fakeIdP struct {
	t      *testing.T
	srv    *httptest.Server
	key    *rsa.PrivateKey
	mu     sync.Mutex
	grants map[string]grant
}

func newFakeIdP(t *testing.T) *fakeIdP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	idp := &fakeIdP{t: t, key: key, grants: map[string]grant{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"issuer":                                idp.srv.URL,
			"authorization_endpoint":                idp.srv.URL + "/authorize",
			"token_endpoint":                        idp.srv.URL + "/token",
			"jwks_uri":                              idp.srv.URL + "/jwks",
			"response_types_supported":              []string{"code"},
			"subject_types_supported":               []string{"public"},
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		pub := idp.key.PublicKey
		writeJSON(w, 200, map[string]any{"keys": []map[string]any{{
			"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "k1",
			"n": b64(pub.N.Bytes()), "e": b64(big.NewInt(int64(pub.E)).Bytes()),
		}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		idp.mu.Lock()
		g, ok := idp.grants[r.PostForm.Get("code")]
		delete(idp.grants, r.PostForm.Get("code"))
		idp.mu.Unlock()
		sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
		if !ok || b64(sum[:]) != g.challenge {
			writeJSON(w, 400, map[string]any{"error": "invalid_grant"})
			return
		}
		writeJSON(w, 200, map[string]any{"access_token": "at", "token_type": "Bearer", "expires_in": 3600, "id_token": idp.sign(g.claims)})
	})
	idp.srv = httptest.NewServer(mux)
	t.Cleanup(idp.srv.Close)
	return idp
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func (idp *fakeIdP) sign(claims map[string]any) string {
	h, _ := json.Marshal(map[string]any{"alg": "RS256", "typ": "JWT", "kid": "k1"})
	c, _ := json.Marshal(claims)
	in := b64(h) + "." + b64(c)
	sum := sha256.Sum256([]byte(in))
	sig, err := rsa.SignPKCS1v15(rand.Reader, idp.key, crypto.SHA256, sum[:])
	if err != nil {
		idp.t.Fatal(err)
	}
	return in + "." + b64(sig)
}

// authorize plays the IdP's login page: it takes the authorization URL our
// server redirected to and returns the callback query (code + state), with
// an ID token for email (claims adjustable via mutate).
func (idp *fakeIdP) authorize(t *testing.T, authURL, clientID, email string, mutate func(map[string]any)) string {
	t.Helper()
	u, err := url.Parse(authURL)
	if err != nil || !strings.HasPrefix(authURL, idp.srv.URL+"/authorize") {
		t.Fatalf("not an authorize URL for this IdP: %s", authURL)
	}
	q := u.Query()
	now := time.Now()
	claims := map[string]any{
		"iss": idp.srv.URL, "sub": "sub-" + email, "aud": clientID, "iat": now.Unix(), "exp": now.Add(5 * time.Minute).Unix(),
		"nonce": q.Get("nonce"), "email": email, "email_verified": true, "groups": []string{"users"},
	}
	if mutate != nil {
		mutate(claims)
	}
	code := "code-" + q.Get("state")[:8]
	idp.mu.Lock()
	idp.grants[code] = grant{challenge: q.Get("code_challenge"), claims: claims}
	idp.mu.Unlock()
	return url.Values{"code": {code}, "state": {q.Get("state")}}.Encode()
}

// ---- fake GitHub ----

type fakeGitHub struct {
	srv        *httptest.Server
	mu         sync.Mutex
	challenges map[string]string
	login      string
	email      string
}

func newFakeGitHub(t *testing.T) *fakeGitHub {
	f := &fakeGitHub{challenges: map[string]string{}, login: "Octo-Cat", email: "octo@example.com"}
	mux := http.NewServeMux()
	mux.HandleFunc("/login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.mu.Lock()
		ch, ok := f.challenges[r.Form.Get("code")]
		f.mu.Unlock()
		sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		w.Header().Set("Content-Type", "application/json")
		if !ok || b64(sum[:]) != ch {
			_, _ = w.Write([]byte(`{"error":"bad_verification_code"}`))
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"gho_tok","token_type":"bearer"}`))
	})
	mux.HandleFunc("/user", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"id": 42, "login": f.login, "name": "Octo"})
	})
	mux.HandleFunc("/user/emails", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		_ = json.NewEncoder(w).Encode([]map[string]any{{"email": f.email, "primary": true, "verified": true}})
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeGitHub) endpoints() github.Endpoints {
	return github.Endpoints{AuthURL: f.srv.URL + "/login/oauth/authorize", TokenURL: f.srv.URL + "/login/oauth/access_token", APIURL: f.srv.URL}
}

func (f *fakeGitHub) authorize(t *testing.T, authURL string) string {
	t.Helper()
	u, _ := url.Parse(authURL)
	q := u.Query()
	code := "gh-" + q.Get("state")[:8]
	f.mu.Lock()
	f.challenges[code] = q.Get("code_challenge")
	f.mu.Unlock()
	return url.Values{"code": {code}, "state": {q.Get("state")}}.Encode()
}

var _ = context.Background

func (h *harness) loginAs(user, pw string, opts ...reqOpt) *httptest.ResponseRecorder {
	return h.do("POST", "/_ui/api/auth/login", map[string]string{"username": user, "password": pw}, opts...)
}

// createUser (as an admin client) creates a user and returns its id.
func (h *harness) createUser(username, role, pw string) string {
	h.t.Helper()
	body := map[string]string{"username": username, "role": role, "name": strings.ToUpper(username)}
	if pw != "" {
		body["password"] = pw
	}
	w := h.do("POST", "/_ui/api/users", body)
	h.expect(w, http.StatusCreated)
	return decode[userView](h.t, w).ID
}

// as returns a new client logged in as username/pw.
func (h *harness) as(username, pw string) *harness {
	h.t.Helper()
	c := h.clone()
	c.expect(c.loginAs(username, pw), http.StatusNoContent)
	return c
}

// newToken creates an API token for the client's user.
func (h *harness) newToken(name string) createdToken {
	h.t.Helper()
	w := h.do("POST", "/_ui/api/me/tokens", map[string]any{"name": name})
	h.expect(w, http.StatusCreated)
	return decode[createdToken](h.t, w)
}

// userByName reads a user from the store.
func (h *harness) userByName(name string) store.User {
	h.t.Helper()
	st := h.store.Get()
	for _, u := range st.Users {
		if u.Username == name {
			return u
		}
	}
	h.t.Fatalf("no user %q", name)
	return store.User{}
}
