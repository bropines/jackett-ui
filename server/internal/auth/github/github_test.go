package github

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bropines/jackett-ui/server/internal/auth/oidc"
)

type testSigner struct{ key []byte }

func (s testSigner) Sign(p []byte) string {
	m := hmac.New(sha256.New, s.key)
	m.Write(p)
	return base64.RawURLEncoding.EncodeToString(p) + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (s testSigner) Verify(t string) ([]byte, bool) {
	a, b, ok := strings.Cut(t, ".")
	if !ok {
		return nil, false
	}
	p, err1 := base64.RawURLEncoding.DecodeString(a)
	sig, err2 := base64.RawURLEncoding.DecodeString(b)
	if err1 != nil || err2 != nil {
		return nil, false
	}
	m := hmac.New(sha256.New, s.key)
	m.Write(p)
	return p, hmac.Equal(m.Sum(nil), sig)
}

// fakeGitHub serves the token endpoint (checks PKCE) and the REST API.
type fakeGitHub struct {
	srv        *httptest.Server
	mu         sync.Mutex
	challenges map[string]string // code -> challenge
	emails     string            // JSON for /user/emails ("" = 403)
	userJSON   string
}

func newFake(t *testing.T) *fakeGitHub {
	f := &fakeGitHub{challenges: map[string]string{},
		userJSON: `{"id":42,"login":"Octo-Cat","name":"Octo"}`,
		emails:   `[{"email":"other@example.com","primary":false,"verified":true},{"email":"Octo@Example.com","primary":true,"verified":true}]`}
	mux := http.NewServeMux()
	mux.HandleFunc("/login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.mu.Lock()
		ch, ok := f.challenges[r.Form.Get("code")]
		delete(f.challenges, r.Form.Get("code"))
		f.mu.Unlock()
		sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if !ok || r.Form.Get("client_id") != "cid" || r.Form.Get("client_secret") != "csecret" ||
			base64.RawURLEncoding.EncodeToString(sum[:]) != ch {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"error":"bad_verification_code"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"gho_tok","token_type":"bearer","scope":"read:user,user:email"}`))
	})
	mux.HandleFunc("/user", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer gho_tok" {
			w.WriteHeader(401)
			return
		}
		_, _ = w.Write([]byte(f.userJSON))
	})
	mux.HandleFunc("/user/emails", func(w http.ResponseWriter, r *http.Request) {
		if f.emails == "" {
			w.WriteHeader(403)
			return
		}
		_, _ = w.Write([]byte(f.emails))
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeGitHub) provider(t *testing.T) *Provider {
	p, err := New(Config{ClientID: "cid", ClientSecret: "csecret", RedirectURL: "https://j.example/_ui/auth/github/callback",
		Endpoints: Endpoints{AuthURL: f.srv.URL + "/login/oauth/authorize", TokenURL: f.srv.URL + "/login/oauth/access_token", APIURL: f.srv.URL}}, f.srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	return p
}

var sig = testSigner{key: []byte("k")}

// start runs Start and returns the flow cookie, state and challenge from the auth URL.
func start(t *testing.T, p *Provider, ret, test string) (*http.Cookie, string, string) {
	t.Helper()
	w := httptest.NewRecorder()
	u, err := p.Start(w, httptest.NewRequest("GET", "/_ui/auth/github/start", nil), sig, ret, test, true)
	if err != nil {
		t.Fatal(err)
	}
	pu, _ := url.Parse(u)
	q := pu.Query()
	if q.Get("code_challenge_method") != "S256" || q.Get("client_id") != "cid" || !strings.Contains(q.Get("scope"), "user:email") {
		t.Fatalf("auth url: %s", u)
	}
	cs := w.Result().Cookies()
	if len(cs) != 1 || cs[0].Name != oidc.FlowCookie || cs[0].Path != "/_ui/auth/" || !cs[0].HttpOnly || !cs[0].Secure || cs[0].SameSite != http.SameSiteLaxMode {
		t.Fatalf("flow cookie: %+v", cs)
	}
	return cs[0], q.Get("state"), q.Get("code_challenge")
}

func finish(p *Provider, c *http.Cookie, query string) (Result, error) {
	r := httptest.NewRequest("GET", "/_ui/auth/github/callback?"+query, nil)
	if c != nil {
		r.AddCookie(c)
	}
	return p.Finish(httptest.NewRecorder(), r, sig, true)
}

func TestHappyPath(t *testing.T) {
	f := newFake(t)
	p := f.provider(t)
	c, state, ch := start(t, p, "/indexers", "tt")
	f.challenges["code1"] = ch
	if got := oidc.FlowTestToken(&http.Request{Header: http.Header{"Cookie": {c.String()}}}, sig); got != "tt" {
		t.Errorf("FlowTestToken = %q", got)
	}
	res, err := finish(p, c, "code=code1&state="+state)
	if err != nil {
		t.Fatal(err)
	}
	if res.Identity.Login != "octo-cat" || res.Identity.Email != "octo@example.com" || res.Identity.ID != 42 ||
		res.Identity.User() != "octo@example.com" || res.ReturnPath != "/indexers" || res.TestToken != "tt" ||
		res.Identity.Subject() != "42" || Issuer != "https://github.com" {
		t.Errorf("result: %+v", res)
	}
}

func TestNoVerifiedEmail(t *testing.T) {
	f := newFake(t)
	f.emails = `[{"email":"x@example.com","primary":true,"verified":false}]`
	p := f.provider(t)
	c, state, ch := start(t, p, "", "")
	f.challenges["c"] = ch
	res, err := finish(p, c, "code=c&state="+state)
	if err != nil || res.Identity.Email != "" || res.Identity.User() != "octo-cat" || res.ReturnPath != "/" {
		t.Fatalf("%+v %v", res, err)
	}
	f.emails = "" // scope missing: 403 on /user/emails is not fatal
	c, state, ch = start(t, p, "", "")
	f.challenges["c2"] = ch
	if res, err = finish(p, c, "code=c2&state="+state); err != nil || res.Identity.Email != "" {
		t.Fatalf("%+v %v", res, err)
	}
}

func TestErrors(t *testing.T) {
	f := newFake(t)
	p := f.provider(t)
	other, _ := New(Config{ClientID: "other", ClientSecret: "s", RedirectURL: "https://j.example/cb"}, nil)

	c, state, ch := start(t, p, "", "")
	f.challenges["good"] = ch
	tampered := *c
	tampered.Value = c.Value[:len(c.Value)-2] + "AA"

	cases := []struct {
		name  string
		p     *Provider
		c     *http.Cookie
		query string
		want  error
	}{
		{"no cookie", p, nil, "code=good&state=" + state, oidc.ErrState},
		{"tampered", p, &tampered, "code=good&state=" + state, oidc.ErrState},
		{"other provider", other, c, "code=good&state=" + state, oidc.ErrState},
		{"state mismatch", p, c, "code=good&state=nope", oidc.ErrState},
		{"idp error", p, c, "error=access_denied&state=" + state, oidc.ErrIdP},
		{"no code", p, c, "state=" + state, oidc.ErrExchange},
		{"wrong code (PKCE/exchange)", p, c, "code=unknown&state=" + state, oidc.ErrExchange},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := finish(tc.p, tc.c, tc.query); !errors.Is(err, tc.want) {
				t.Errorf("err = %v, want %v", err, tc.want)
			}
		})
	}

	// PKCE: right code but the challenge doesn't match the verifier.
	c2, state2, _ := start(t, p, "", "")
	f.challenges["pkce"] = "not-the-challenge"
	if _, err := finish(p, c2, "code=pkce&state="+state2); !errors.Is(err, oidc.ErrExchange) {
		t.Errorf("pkce mismatch: %v", err)
	}

	// Expired flow.
	c3, state3, ch3 := start(t, p, "", "")
	f.challenges["late"] = ch3
	now = func() time.Time { return time.Now().Add(oidc.FlowTTL + time.Minute) }
	defer func() { now = time.Now }()
	if _, err := finish(p, c3, "code=late&state="+state3); !errors.Is(err, oidc.ErrFlowExpired) {
		t.Errorf("expired: %v", err)
	}
}

func TestBadProfile(t *testing.T) {
	f := newFake(t)
	f.userJSON = `{"id":0,"login":""}`
	p := f.provider(t)
	c, state, ch := start(t, p, "", "")
	f.challenges["c"] = ch
	if _, err := finish(p, c, "code=c&state="+state); !errors.Is(err, oidc.ErrToken) {
		t.Fatalf("err = %v", err)
	}
}

func TestNewValidation(t *testing.T) {
	for _, cfg := range []Config{
		{ClientSecret: "s", RedirectURL: "https://x/cb"},
		{ClientID: "c", RedirectURL: "https://x/cb"},
		{ClientID: "c", ClientSecret: "s", RedirectURL: "/cb"},
		{ClientID: "c", ClientSecret: "s", RedirectURL: "ftp://x/cb"},
	} {
		if _, err := New(cfg, nil); !errors.Is(err, oidc.ErrNotConfigured) {
			t.Errorf("%+v: err = %v", cfg, err)
		}
	}
	p, err := New(Config{ClientID: "c", ClientSecret: "s", RedirectURL: "https://x/cb"}, nil)
	if err != nil || p.Config().Endpoints != Default {
		t.Fatalf("defaults: %v %+v", err, p)
	}
	b, _ := json.Marshal(Scopes)
	if string(b) != `["read:user","user:email"]` {
		t.Errorf("scopes %s", b)
	}
}
