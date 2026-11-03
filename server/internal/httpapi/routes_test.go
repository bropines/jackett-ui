package httpapi

import (
	"compress/gzip"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bropines/jackett-ui/server/internal/jackett/jackettfake"
	"github.com/bropines/jackett-ui/server/internal/session"
	"github.com/bropines/jackett-ui/server/internal/store"
)

const key = jackettfake.APIKey

func TestSetupGating(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	st := h.state()
	if !st.SetupRequired || st.Authenticated || st.Mode != "password" || st.PasswordLogin {
		t.Fatalf("fresh state: %+v", st)
	}
	if st.Jackett.Version != "" {
		t.Fatal("anonymous state reveals the Jackett version")
	}

	// Everything protected answers setup_required; Jackett is unreachable,
	// API-key routes included.
	for _, target := range []string{
		"/api/v2.0/indexers",
		"/api/v2.0/indexers/all/results?apikey=" + key,
		"/dl/x/?jackett_apikey=" + key,
		"/UI/whatever",
		"/_ui/api/settings",
	} {
		w := h.do("GET", target, nil)
		if w.Code != 401 || errorCode(w) != "setup_required" {
			t.Fatalf("%s: %d %s", target, w.Code, w.Body)
		}
	}
	// Only our own status probe/login may have reached Jackett; no client
	// request was proxied.
	for _, s := range h.jackett.Seen() {
		if s.Path != "/api/v2.0/server/config" && s.Path != "/UI/Dashboard" {
			t.Fatalf("request proxied to Jackett during setup: %s", s.Path)
		}
	}
	// Static and health still work.
	h.expect(h.do("GET", "/", nil), 200)
	h.expect(h.do("GET", "/healthz", nil), 200)
	// Login is not possible yet.
	if w := h.login(adminPW); w.Code != 409 || errorCode(w) != "setup_required" {
		t.Fatalf("login during setup: %d %s", w.Code, w.Body)
	}
	// Setup validation + CSRF.
	if w := h.do("POST", "/_ui/api/auth/setup", map[string]string{"password": "short"}); w.Code != 400 || errorCode(w) != "password_too_short" {
		t.Fatalf("short password: %d %s", w.Code, w.Body)
	}
	if w := h.do("POST", "/_ui/api/auth/setup", `{"password":"longenough1"}`, hdr("Content-Type", "text/plain")); w.Code != 403 {
		t.Fatalf("setup without CSRF header: %d", w.Code)
	}

	h.setup()
	if _, ok := h.jar[session.CookieName]; !ok {
		t.Fatal("setup did not log in")
	}
	st = h.state()
	if st.SetupRequired || !st.Authenticated || st.User != "admin" || !st.PasswordLogin {
		t.Fatalf("after setup: %+v", st)
	}
	if !st.Jackett.OK || st.Jackett.Version == "" {
		t.Fatalf("jackett status: %+v", st.Jackett)
	}
	// Second setup → 409.
	if w := h.do("POST", "/_ui/api/auth/setup", map[string]string{"password": "another-pass"}); w.Code != 409 {
		t.Fatalf("second setup: %d", w.Code)
	}
	// Jackett is reachable now.
	h.expect(h.do("GET", "/api/v2.0/indexers", nil), 200)

	// The password is stored hashed only.
	raw, _ := os.ReadFile(filepath.Join(h.env["DATA_DIR"], store.FileName))
	if strings.Contains(string(raw), adminPW) || !strings.Contains(string(raw), "$2a$12$") {
		t.Fatal("password not stored as bcrypt hash")
	}
}

func TestRoutingMatrix(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	anon := h.clone()

	cases := []struct {
		method, target string
		anon, authed   int
	}{
		{"GET", "/", 200, 200},
		{"GET", "/settings", 200, 200}, // SPA route
		{"GET", "/favicon.svg", 200, 200},
		{"GET", "/assets/app-abc.js", 200, 200},
		{"GET", "/assets/missing.js", 404, 404},
		{"GET", "/.secret", 200, 200}, // hidden file not served: SPA index instead
		{"POST", "/", 405, 405},
		{"GET", "/healthz", 200, 200},
		{"GET", "/_ui/api/auth/state", 200, 200},
		{"GET", "/_ui/api/settings", 401, 200},
		{"GET", "/_ui/api/nope", 401, 404},
		{"GET", "/_ui/nope", 404, 404},
		{"GET", "/_ui/auth/unknown/start", 404, 404},
		{"GET", "/api/v2.0/indexers", 401, 200},
		{"GET", "/API/v2.0/indexers", 401, 200},
		{"GET", "/api/v2.0/server/config?apikey=" + key, 401, 200}, // the key doesn't open non-search routes
		{"GET", "/api/v2.0/indexers/all/results/../../../server/config?apikey=" + key, 401, 200},
		{"GET", "/api/v2.0/indexers/x/resultsX?apikey=" + key, 401, 200},
		{"GET", "/api/v2.0/indexers/all/results?apikey=" + key + "&Query=x", 200, 200},
		{"GET", "/api/v2.0/indexers/rutor/results/torznab/api?apikey=" + key + "&t=caps", 200, 200},
		{"GET", "/api/v2.0/indexers/rutor/results/potato/?apikey=" + key, 200, 200},
		{"GET", "/dl/rutor/?jackett_apikey=" + key + "&path=x", 200, 200},
		{"GET", "/bh/rutor/?jackett_apikey=" + key, 200, 200},
		{"GET", "/api/v2.0/indexers/all/results?Query=x", 401, 401}, // no key: ours (anon) / Jackett's (authed, no cookie sent)
		{"GET", "/api/v2.0/indexers/all/results?apikey=", 401, 401},
		{"GET", "/dl/rutor/?path=x", 401, 401},
		{"GET", "/UI/Dashboard", 404, 404},
		{"POST", "/UI/Dashboard", 404, 404},
		{"GET", "/ui/dashboard", 404, 404},
		{"GET", "/UI/Login", 404, 404},
		{"GET", "/UI/Login/", 404, 404},
		{"GET", "/UI//Dashboard", 404, 404},
		{"GET", "/UI/Logout", 302, 302},
		{"GET", "/UI/other", 401, 200},
		{"GET", "/api/v2.0/indexers/a\\..\\server", 400, 400},
	}
	for _, c := range cases {
		t.Run(c.method+" "+c.target, func(t *testing.T) {
			if w := anon.do(c.method, c.target, nil); w.Code != c.anon {
				t.Errorf("anonymous: %d, want %d (%s)", w.Code, c.anon, w.Body)
			}
			if w := h.do(c.method, c.target, nil, xhr); w.Code != c.authed {
				t.Errorf("authenticated: %d, want %d (%s)", w.Code, c.authed, w.Body)
			}
			if _, ok := h.jar[session.CookieName]; !ok {
				h.login(adminPW) // /UI/Logout logged us out
			}
		})
	}

	// API-key requests never carried our Jackett cookie, even from a
	// logged-in browser; protected requests always did.
	for _, s := range h.jackett.Seen() {
		apiKey := isAPIKeyRoute(strings.ToLower(s.Path))
		hasCookie := s.Header.Get("Cookie") != ""
		if apiKey && hasCookie {
			t.Errorf("API-key request %s got a cookie", s.Path)
		}
		if !apiKey && s.Path != "/UI/Dashboard" && s.Path != "/api/v2.0/server/config" && !hasCookie {
			t.Errorf("protected request %s without our cookie", s.Path)
		}
		if strings.Contains(s.Header.Get("Cookie"), "jui_session") {
			t.Errorf("browser cookie leaked to Jackett on %s", s.Path)
		}
	}
	// Normalised path reaches Jackett (no traversal).
	if _, ok := h.jackett.Last("/api/v2.0/server/config"); !ok {
		t.Error("cleaned path not proxied")
	}
}

func TestUILogoutClearsSession(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	w := h.do("GET", "/UI/Logout", nil)
	if w.Code != 302 || w.Header().Get("Location") != "/" {
		t.Fatalf("%d %v", w.Code, w.Header())
	}
	if _, ok := h.jar[session.CookieName]; ok {
		t.Fatal("cookie not cleared")
	}
	h.expect(h.do("GET", "/api/v2.0/indexers", nil), 401)
}

func TestCSRF(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	cases := []struct {
		name   string
		method string
		target string
		body   any
		opts   []reqOpt
		want   int
	}{
		{"post without headers", "POST", "/api/v2.0/indexers/x/test", "", nil, 403},
		{"post form", "POST", "/api/v2.0/indexers/x/test", "a=b", []reqOpt{hdr("Content-Type", "application/x-www-form-urlencoded")}, 403},
		{"post text/plain", "POST", "/api/v2.0/indexers/x/test", "{}", []reqOpt{hdr("Content-Type", "text/plain")}, 403},
		{"post with XRW", "POST", "/api/v2.0/indexers/x/test", "", []reqOpt{xhr}, 200},
		{"post json", "POST", "/api/v2.0/indexers/x/config", map[string]any{}, nil, 200},
		{"json with charset", "POST", "/api/v2.0/indexers/x/config", "{}", []reqOpt{hdr("Content-Type", "application/json; charset=utf-8")}, 200},
		{"delete with XRW", "DELETE", "/api/v2.0/indexers/x", nil, []reqOpt{xhr}, 200},
		{"delete without", "DELETE", "/api/v2.0/indexers/x", nil, nil, 403},
		{"cross origin", "POST", "/api/v2.0/indexers/x/test", "", []reqOpt{xhr, hdr("Origin", "https://evil.example")}, 403},
		{"null origin", "POST", "/api/v2.0/indexers/x/test", "", []reqOpt{xhr, hdr("Origin", "null")}, 403},
		{"same origin", "POST", "/api/v2.0/indexers/x/test", "", []reqOpt{xhr, hdr("Origin", "http://ui.test")}, 200},
		{"https origin behind untrusted TLS proxy", "POST", "/api/v2.0/indexers/x/test", "", []reqOpt{xhr, hdr("Origin", "https://ui.test")}, 200},
		{"settings put without header", "PUT", "/_ui/api/settings", "{}", []reqOpt{hdr("Content-Type", "text/plain")}, 403},
		{"logout-all cross origin", "POST", "/_ui/api/auth/logout-all", nil, []reqOpt{xhr, hdr("Origin", "http://evil")}, 403},
		{"login form post", "POST", "/_ui/api/auth/login", "password=x", []reqOpt{hdr("Content-Type", "application/x-www-form-urlencoded")}, 403},
		{"get is exempt", "GET", "/api/v2.0/indexers", nil, nil, 200},
		{"api-key route exempt (no ambient credentials)", "POST", "/api/v2.0/indexers/all/results?apikey=" + key, "", nil, 200},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := h.do(c.method, c.target, c.body, c.opts...)
			if w.Code != c.want {
				t.Fatalf("status %d, want %d: %s", w.Code, c.want, w.Body)
			}
			if c.want == 403 && errorCode(w) != "csrf" {
				t.Fatalf("error %q", errorCode(w))
			}
		})
	}
}

func TestLoginRateLimitLogout(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	anon := h.clone()
	if w := anon.login("wrong-password"); w.Code != 401 || errorCode(w) != "invalid_credentials" {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if w := anon.login(adminPW); w.Code != 204 {
		t.Fatalf("login: %d %s", w.Code, w.Body)
	}
	c := anon.jar[session.CookieName]
	if c == "" {
		t.Fatal("no session cookie")
	}
	st := anon.state()
	if !st.Authenticated || st.User != "admin" {
		t.Fatalf("%+v", st)
	}

	// Burst of 5 per IP (the setup above and the two logins used 3 tokens
	// of the harness IP; use a fresh IP).
	attacker := h.clone()
	attacker.remote = "198.51.100.66:1"
	var last int
	var retry string
	for i := 0; i < 7; i++ {
		w := attacker.login("guess-" + string(rune('a'+i)))
		last, retry = w.Code, w.Header().Get("Retry-After")
	}
	if last != 429 || retry == "" || retry == "0" {
		t.Fatalf("no rate limit: %d Retry-After=%q", last, retry)
	}
	// Other IPs unaffected.
	other := h.clone()
	other.remote = "198.51.100.67:1"
	if w := other.login(adminPW); w.Code != 204 {
		t.Fatalf("other IP: %d", w.Code)
	}
	// X-Forwarded-For from an untrusted peer does not change the bucket.
	if w := attacker.login("x", hdr("X-Forwarded-For", "203.0.113.99")); w.Code != 429 {
		t.Fatalf("XFF spoof bypassed the limiter: %d", w.Code)
	}

	// Logout.
	anon.expect(anon.do("POST", "/_ui/api/auth/logout", nil, xhr), 204)
	if anon.state().Authenticated {
		t.Fatal("still authenticated after logout")
	}
	// Logout-all bumps the epoch: other sessions die.
	epoch := h.store.Get().AuthEpoch
	other.expect(other.do("POST", "/_ui/api/auth/logout-all", nil, xhr), 204)
	if h.store.Get().AuthEpoch != epoch+1 {
		t.Fatal("epoch not bumped")
	}
	h.expect(h.do("GET", "/api/v2.0/indexers", nil), 401)
	other.expect(other.do("GET", "/api/v2.0/indexers", nil), 401)
	// A replayed old cookie is dead too.
	replay := h.clone()
	replay.jar[session.CookieName] = c
	replay.expect(replay.do("GET", "/_ui/api/settings", nil), 401)
}

func TestSessionCookieAttributes(t *testing.T) {
	h := newHarness(t, harnessOpt{env: map[string]string{"TRUSTED_PROXIES": "192.0.2.0/24"}})
	w := h.do("POST", "/_ui/api/auth/setup", map[string]string{"password": adminPW}, hdr("X-Forwarded-Proto", "https"))
	h.expect(w, 204)
	var c *http.Cookie
	for _, ck := range w.Result().Cookies() {
		if ck.Name == session.CookieName {
			c = ck
		}
	}
	if c == nil || !c.Secure || !c.HttpOnly || c.SameSite != http.SameSiteLaxMode || c.Path != "/" {
		t.Fatalf("cookie: %+v", c)
	}
	// Untrusted peer: X-Forwarded-Proto ignored → not Secure.
	h2 := newHarness(t, harnessOpt{})
	w = h2.do("POST", "/_ui/api/auth/setup", map[string]string{"password": adminPW}, hdr("X-Forwarded-Proto", "https"))
	for _, ck := range w.Result().Cookies() {
		if ck.Name == session.CookieName && ck.Secure {
			t.Fatal("Secure from untrusted X-Forwarded-Proto")
		}
	}
	// PUBLIC_URL https → Secure.
	h3 := newHarness(t, harnessOpt{env: map[string]string{"PUBLIC_URL": "https://jackett.example.com"}})
	w = h3.do("POST", "/_ui/api/auth/setup", map[string]string{"password": adminPW})
	for _, ck := range w.Result().Cookies() {
		if ck.Name == session.CookieName && !ck.Secure {
			t.Fatal("PUBLIC_URL https but cookie not Secure")
		}
	}
}

func TestForwardedHeadersToJackett(t *testing.T) {
	h := newHarness(t, harnessOpt{env: map[string]string{"TRUSTED_PROXIES": "192.0.2.0/24"}})
	h.setup()
	h.expect(h.do("GET", "/api/v2.0/indexers", nil, hdr("X-Forwarded-For", "203.0.113.5"), hdr("X-Forwarded-Proto", "https"), hdr("X-Forwarded-Host", "jackett.example.com")), 200)
	s, _ := h.jackett.Last("/api/v2.0/indexers")
	if s.Header.Get("X-Forwarded-For") != "203.0.113.5, 192.0.2.10" || s.Header.Get("X-Forwarded-Proto") != "https" ||
		s.Header.Get("X-Forwarded-Host") != "jackett.example.com" || s.Host != "jackett.example.com" {
		t.Fatalf("forwarded: %v host=%s", s.Header, s.Host)
	}
	// Untrusted client: its X-Forwarded-* are replaced.
	u := newHarness(t, harnessOpt{})
	u.setup()
	u.expect(u.do("GET", "/api/v2.0/indexers", nil, hdr("X-Forwarded-For", "6.6.6.6"), hdr("X-Forwarded-Host", "evil")), 200)
	s, _ = u.jackett.Last("/api/v2.0/indexers")
	if s.Header.Get("X-Forwarded-For") != "192.0.2.10" || s.Header.Get("X-Forwarded-Host") != testHost {
		t.Fatalf("untrusted forwarded: %v", s.Header)
	}
}

func TestJackettLoginFailedState(t *testing.T) {
	h := newHarness(t, harnessOpt{env: map[string]string{"JACKETT_PASSWORD": "wrong"}})
	h.setup()
	st := h.state()
	if st.Jackett.OK || st.Jackett.Error != "jackett_login_failed" {
		t.Fatalf("%+v", st.Jackett)
	}
	w := h.do("GET", "/api/v2.0/indexers", nil, xhr)
	if w.Code != 502 || errorCode(w) != "jackett_login_failed" {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}

func TestSecurityHeadersStaticAndGzip(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	for _, target := range []string{"/", "/healthz", "/_ui/api/auth/state", "/api/v2.0/indexers", "/nope/route"} {
		w := h.do("GET", target, nil)
		for k, v := range map[string]string{"X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY"} {
			if got := w.Header().Values(k); len(got) != 1 || got[0] != v {
				t.Errorf("%s %s = %v", target, k, got)
			}
		}
		if !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
			t.Errorf("%s: no CSP", target)
		}
	}
	// Cache rules.
	if w := h.do("GET", "/", nil); w.Header().Get("Cache-Control") != "no-cache" || !strings.Contains(w.Body.String(), "jackett-ui index") {
		t.Fatalf("index: %v", w.Header())
	}
	if w := h.do("GET", "/some/spa/route", nil); w.Header().Get("Cache-Control") != "no-cache" || !strings.Contains(w.Body.String(), "jackett-ui index") {
		t.Fatal("SPA fallback")
	}
	if w := h.do("GET", "/assets/app-abc.js", nil); w.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" ||
		!strings.Contains(w.Header().Get("Content-Type"), "javascript") {
		t.Fatalf("asset headers: %v", w.Header())
	}
	if w := h.do("GET", "/assets/missing.js", nil); w.Code != 404 || strings.Contains(w.Body.String(), "index") {
		t.Fatal("missing asset must 404, not fall back to index")
	}
	// gzip: big JS compressed, round-trips.
	w := h.do("GET", "/assets/app-abc.js", nil, hdr("Accept-Encoding", "gzip, deflate, br"))
	if w.Header().Get("Content-Encoding") != "gzip" || !strings.Contains(w.Header().Get("Vary"), "Accept-Encoding") || w.Header().Get("Content-Length") != "" {
		t.Fatalf("gzip headers: %v", w.Header())
	}
	zr, err := gzip.NewReader(w.Body)
	if err != nil {
		t.Fatal(err)
	}
	plain, _ := io.ReadAll(zr)
	if len(plain) < bigAssetSize || !strings.HasPrefix(string(plain), "console.log") {
		t.Fatalf("gunzipped %d bytes", len(plain))
	}
	// Small file: not compressed.
	if w := h.do("GET", "/assets/small-1.css", nil, hdr("Accept-Encoding", "gzip")); w.Header().Get("Content-Encoding") != "" {
		t.Fatal("small file compressed")
	}
	// No Accept-Encoding: not compressed.
	if w := h.do("GET", "/assets/app-abc.js", nil); w.Header().Get("Content-Encoding") != "" {
		t.Fatal("compressed without Accept-Encoding")
	}
	// Images are not compressed.
	if w := h.do("GET", "/assets/img/logo.png", nil, hdr("Accept-Encoding", "gzip")); w.Header().Get("Content-Encoding") != "" {
		t.Fatal("png compressed")
	}
	// Proxied big JSON is compressed too (unless Jackett already did).
	w = h.do("GET", "/api/v2.0/big", nil, hdr("Accept-Encoding", "gzip"))
	if w.Code != 200 || w.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("proxied json: %d %v", w.Code, w.Header())
	}
	// Range requests are not gzipped.
	w = h.do("GET", "/assets/app-abc.js", nil, hdr("Accept-Encoding", "gzip"), hdr("Range", "bytes=0-99"))
	if w.Code != 206 || w.Header().Get("Content-Encoding") != "" || w.Body.Len() != 100 {
		t.Fatalf("range: %d %v len=%d", w.Code, w.Header(), w.Body.Len())
	}
	// HEAD works and has no body.
	if w := h.do("HEAD", "/", nil); w.Code != 200 || w.Body.Len() != 0 {
		t.Fatalf("HEAD: %d %d", w.Code, w.Body.Len())
	}
}

func TestHeaderMode(t *testing.T) {
	h := newHarness(t, harnessOpt{env: map[string]string{"AUTH_MODE": "header", "AUTH_HEADER_TRUSTED": "10.0.0.0/8"}})
	proxyClient := h.clone()
	proxyClient.remote = "10.0.0.5:1"
	st := h.state()
	if st.SetupRequired || st.Authenticated || st.PasswordLogin {
		t.Fatalf("%+v", st)
	}
	h.expect(h.do("GET", "/api/v2.0/indexers", nil, hdr("Remote-User", "alice")), 401) // untrusted peer
	proxyClient.expect(proxyClient.do("GET", "/api/v2.0/indexers", nil), 401)          // trusted, no header
	proxyClient.expect(proxyClient.do("GET", "/api/v2.0/indexers", nil, hdr("Remote-User", "alice")), 200)
	w := proxyClient.do("GET", "/_ui/api/auth/state", nil, hdr("Remote-User", "alice"))
	if s := decode[stateResponse](t, w); !s.Authenticated || s.User != "alice" || s.Mode != "header" {
		t.Fatalf("%+v", s)
	}
	if w := h.login("whatever-pass"); w.Code != 403 || errorCode(w) != "password_login_disabled" {
		t.Fatalf("password login in header mode: %d", w.Code)
	}
}

func TestNoneMode(t *testing.T) {
	h := newHarness(t, harnessOpt{env: map[string]string{"AUTH_MODE": "none"}})
	st := h.state()
	if !st.Authenticated || st.SetupRequired || st.Mode != "none" {
		t.Fatalf("%+v", st)
	}
	h.expect(h.do("GET", "/api/v2.0/indexers", nil), 200)
}

func TestSlidingRenewal(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	before := h.jar[session.CookieName]
	// Move the server clock past half the TTL (168h): the cookie is renewed.
	base := h.srv.sessions.Now()
	h.srv.sessions.Now = func() time.Time { return base.Add(100 * time.Hour) }
	w := h.do("GET", "/_ui/api/settings", nil)
	h.expect(w, 200)
	if after := h.jar[session.CookieName]; after == before {
		t.Fatal("session not renewed past half TTL")
	}
	// Past expiry: rejected.
	h.srv.sessions.Now = func() time.Time { return base.Add(400 * time.Hour) }
	h.expect(h.do("GET", "/_ui/api/settings", nil), 401)
}
