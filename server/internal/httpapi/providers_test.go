package httpapi

import (
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/bropines/jackett-ui/server/internal/auth/oidc"
	"github.com/bropines/jackett-ui/server/internal/session"
)

const (
	oidcClient = "jui-client"
	userEmail  = "alice@example.com"
)

// location returns the redirect target of w.
func location(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	if w.Code != 302 {
		t.Fatalf("status %d, want 302: %s", w.Code, w.Body)
	}
	return w.Header().Get("Location")
}

// startTest runs POST …/test and returns the start URL and token.
func (h *harness) startTest(id string, body any) (string, string) {
	h.t.Helper()
	w := h.do("POST", "/_ui/api/settings/providers/"+id+"/test", body, xhr)
	h.expect(w, 200)
	r := decode[map[string]string](h.t, w)
	u, _ := url.Parse(r["url"])
	if u.Path != "/_ui/auth/"+id+"/start" || u.Query().Get("test") == "" || u.Query().Get("test") != r["token"] {
		h.t.Fatalf("test url %q", r["url"])
	}
	return r["url"], r["token"]
}

func (h *harness) testStatus(id, tok string) testStatus {
	h.t.Helper()
	w := h.do("GET", "/_ui/api/settings/providers/"+id+"/test/"+tok, nil)
	h.expect(w, 200)
	return decode[testStatus](h.t, w)
}

// configureOIDC stores the oidc provider for idp and verifies it with the
// test flow, then switches to sso.
func configureOIDC(t *testing.T, h *harness, idp *fakeIdP) {
	t.Helper()
	h.expect(h.put(map[string]any{"auth": map[string]any{
		"allowedEmails": []string{userEmail},
		"providers":     map[string]any{"oidc": map[string]any{"issuer": idp.srv.URL, "clientId": oidcClient, "clientSecret": "s3cret", "providerName": "Authentik"}},
	}}), 200)
	startURL, tok := h.startTest("oidc", map[string]any{})
	if st := h.testStatus("oidc", tok); st.Status != "pending" {
		t.Fatalf("status %+v", st)
	}
	sessBefore := h.jar[session.CookieName]
	auth := location(t, h.do("GET", startURL, nil))
	w := h.do("GET", "/_ui/auth/oidc/callback?"+idp.authorize(t, auth, oidcClient, userEmail, nil), nil)
	h.expect(w, 200)
	if !strings.Contains(w.Body.String(), "Проверка пройдена") {
		t.Fatalf("test page: %s", w.Body)
	}
	if h.jar[session.CookieName] != sessBefore {
		t.Fatal("test login changed the caller's session")
	}
	if st := h.testStatus("oidc", tok); st.Status != "verified" {
		t.Fatalf("status %+v", st)
	}
	if !h.settings().Auth.Providers["oidc"].Verified {
		t.Fatal("not verified after test")
	}
	h.expect(h.put(`{"auth":{"mode":"sso"}}`), 200)
}

func TestOIDCLoginEndToEnd(t *testing.T) {
	idp := newFakeIdP(t)
	h := newHarness(t, harnessOpt{})
	h.setup()

	// Before an allow-list exists the test is refused.
	h.expect(h.put(map[string]any{"auth": map[string]any{"providers": map[string]any{"oidc": map[string]any{"issuer": idp.srv.URL, "clientId": oidcClient, "clientSecret": "s3cret"}}}}), 200)
	if w := h.do("POST", "/_ui/api/settings/providers/oidc/test", map[string]any{}); w.Code != 409 || errorCode(w) != "allowlist_required" {
		t.Fatalf("test without allow-list: %d %s", w.Code, w.Body)
	}

	configureOIDC(t, h, idp)

	// The caller kept its session across the mode switch.
	if st := h.state(); !st.Authenticated || st.Mode != "sso" {
		t.Fatalf("caller after switch: %+v", st)
	}
	anon := h.clone()
	st := anon.state()
	if len(st.Providers) != 1 || st.Providers[0].ID != "oidc" || st.Providers[0].Name != "Authentik" || !st.PasswordLogin {
		t.Fatalf("login page state: %+v", st)
	}
	// CSP allows the IdP as form-action.
	if !strings.Contains(anon.do("GET", "/", nil).Header().Get("Content-Security-Policy"), "form-action 'self' "+idp.srv.URL) {
		t.Fatal("CSP form-action lacks the issuer")
	}

	// Login: start → IdP → callback → session → return path.
	auth := location(t, anon.do("GET", "/_ui/auth/oidc/start?return=/search%3Fq%3D1", nil))
	if !strings.HasPrefix(auth, idp.srv.URL+"/authorize") || !strings.Contains(auth, url.QueryEscape("http://ui.test/_ui/auth/oidc/callback")) {
		t.Fatalf("auth url %s", auth)
	}
	if _, ok := anon.jar[oidc.FlowCookie]; !ok {
		t.Fatal("no flow cookie")
	}
	back := location(t, anon.do("GET", "/_ui/auth/oidc/callback?"+idp.authorize(t, auth, oidcClient, userEmail, nil), nil))
	if back != "/search?q=1" {
		t.Fatalf("return to %q", back)
	}
	if st := anon.state(); !st.Authenticated || st.User != userEmail {
		t.Fatalf("after login: %+v", st)
	}
	anon.expect(anon.do("GET", "/api/v2.0/indexers", nil), 200)

	// Open redirect attempts end at "/".
	for _, ret := range []string{"https://evil.com", "//evil.com", "/\\evil.com"} {
		c := h.clone()
		auth := location(t, c.do("GET", "/_ui/auth/oidc/start?return="+url.QueryEscape(ret), nil))
		if back := location(t, c.do("GET", "/_ui/auth/oidc/callback?"+idp.authorize(t, auth, oidcClient, userEmail, nil), nil)); back != "/" {
			t.Fatalf("return %q → %q", ret, back)
		}
	}

	errorCases := []struct {
		name   string
		email  string
		mutate func(map[string]any)
		query  func(q string) string
		want   string
	}{
		{"disallowed email", "mallory@example.com", nil, nil, "user_not_allowed"},
		{"unverified email", userEmail, func(c map[string]any) { c["email_verified"] = false }, nil, "email_not_verified"},
		{"wrong nonce", userEmail, func(c map[string]any) { c["nonce"] = "other" }, nil, "nonce_mismatch"},
		{"wrong state", userEmail, nil, func(q string) string {
			v, _ := url.ParseQuery(q)
			v.Set("state", "forged")
			return v.Encode()
		}, "state_mismatch"},
		{"idp error", userEmail, nil, func(string) string { return "error=access_denied&error_description=" + url.QueryEscape("<script>") }, "idp_error"},
	}
	for _, c := range errorCases {
		t.Run(c.name, func(t *testing.T) {
			cl := h.clone()
			auth := location(t, cl.do("GET", "/_ui/auth/oidc/start", nil))
			q := idp.authorize(t, auth, oidcClient, c.email, c.mutate)
			if c.query != nil {
				q = c.query(q)
			}
			back := location(t, cl.do("GET", "/_ui/auth/oidc/callback?"+q, nil))
			if back != "/?authError="+c.want {
				t.Fatalf("redirect %q, want authError=%s", back, c.want)
			}
			if _, ok := cl.jar[session.CookieName]; ok {
				t.Fatal("session issued on failure")
			}
		})
	}
	// Callback without a started flow.
	if back := location(t, h.clone().do("GET", "/_ui/auth/oidc/callback?code=x&state=y", nil)); back != "/?authError=state_mismatch" {
		t.Fatalf("no flow: %s", back)
	}

	// Changing the secret resets verified: the button disappears, the
	// password fallback keeps a way in.
	h.expect(h.put(map[string]any{"auth": map[string]any{"providers": map[string]any{"oidc": map[string]any{"clientSecret": "rotated"}}}}), 200)
	if st := anon.clone().state(); len(st.Providers) != 0 {
		t.Fatalf("unverified provider still offered: %+v", st.Providers)
	}
	if back := location(t, h.clone().do("GET", "/_ui/auth/oidc/start", nil)); back != "/?authError=provider_disabled" {
		t.Fatalf("start of unverified provider: %s", back)
	}
	// Without the fallback that change would lock everybody out.
	h.expect(h.put(map[string]any{"auth": map[string]any{"providers": map[string]any{"oidc": map[string]any{"clientSecret": "s3cret"}}}}), 200) // verified again (same values)
	if !h.settings().Auth.Providers["oidc"].Verified {
		t.Fatal("restoring the tested values did not restore verified")
	}
	h.expect(h.put(`{"auth":{"passwordFallback":false}}`), 200)
	if w := h.put(map[string]any{"auth": map[string]any{"providers": map[string]any{"oidc": map[string]any{"clientSecret": "rotated"}}}}); w.Code != 409 || errorCode(w) != "would_lock_out" {
		t.Fatalf("lock-out change: %d %s", w.Code, w.Body)
	}
	// Password login is now refused.
	if w := h.clone().login(adminPW); w.Code != 403 {
		t.Fatalf("password login with fallback off: %d", w.Code)
	}
}

func TestOIDCTestFlowFailures(t *testing.T) {
	idp := newFakeIdP(t)
	h := newHarness(t, harnessOpt{})
	h.setup()
	h.expect(h.put(map[string]any{"auth": map[string]any{"allowedEmails": []string{userEmail}}}), 200)

	// Unsaved form values are tested; an empty secret means "stored" (none here).
	startURL, tok := h.startTest("oidc", map[string]any{"issuer": idp.srv.URL, "clientId": oidcClient, "clientSecret": "s3cret"})
	auth := location(t, h.do("GET", startURL, nil))
	w := h.do("GET", "/_ui/auth/oidc/callback?"+idp.authorize(t, auth, oidcClient, "mallory@example.com", nil), nil)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "user_not_allowed") {
		t.Fatalf("failed test page: %d %s", w.Code, w.Body)
	}
	st := h.testStatus("oidc", tok)
	if st.Status != "failed" || st.Error != "user_not_allowed" || st.Message == "" {
		t.Fatalf("status %+v", st)
	}
	if h.store.Get().Auth.Providers.OIDC.VerifiedHash != "" {
		t.Fatal("failed test marked verified")
	}

	// A passing test of unsaved values: saving exactly those keeps verified.
	startURL, tok = h.startTest("oidc", map[string]any{"issuer": idp.srv.URL, "clientId": oidcClient, "clientSecret": "s3cret"})
	auth = location(t, h.do("GET", startURL, nil))
	h.expect(h.do("GET", "/_ui/auth/oidc/callback?"+idp.authorize(t, auth, oidcClient, userEmail, nil), nil), 200)
	if h.testStatus("oidc", tok).Status != "verified" {
		t.Fatal("not verified")
	}
	if h.settings().Auth.Providers["oidc"].Verified {
		t.Fatal("unsaved values show as verified before saving")
	}
	h.expect(h.put(map[string]any{"auth": map[string]any{"providers": map[string]any{"oidc": map[string]any{"issuer": idp.srv.URL, "clientId": oidcClient, "clientSecret": "s3cret"}}}}), 200)
	if !h.settings().Auth.Providers["oidc"].Verified {
		t.Fatal("saving the tested values did not keep verified")
	}

	// Discovery failure → 400 with a message, nothing stored.
	w = h.do("POST", "/_ui/api/settings/providers/oidc/test", map[string]any{"issuer": "http://127.0.0.1:1/nope"})
	if w.Code != 400 || errorCode(w) != "provider_setup_failed" {
		t.Fatalf("discovery failure: %d %s", w.Code, w.Body)
	}
	// Unknown / expired tokens.
	h.expect(h.do("GET", "/_ui/api/settings/providers/oidc/test/unknown", nil), 404)
	if w := h.do("GET", "/_ui/auth/oidc/start?test=unknown", nil); w.Code != 400 {
		t.Fatalf("unknown test token start: %d", w.Code)
	}
	// The test endpoints are protected.
	h.clone().expect(h.clone().do("POST", "/_ui/api/settings/providers/oidc/test", map[string]any{}), 401)
	// Incomplete provider.
	if w := h.do("POST", "/_ui/api/settings/providers/google/test", map[string]any{}); w.Code != 400 || errorCode(w) != "provider_incomplete" {
		t.Fatalf("incomplete: %d %s", w.Code, w.Body)
	}
}

func TestGoogleAndCrossProvider(t *testing.T) {
	oidcIdP := newFakeIdP(t)
	googleIdP := newFakeIdP(t)
	h := newHarness(t, harnessOpt{google: googleIdP.srv.URL})
	h.setup()
	configureOIDC(t, h, oidcIdP)

	h.expect(h.put(map[string]any{"auth": map[string]any{"providers": map[string]any{"google": map[string]any{"clientId": "gclient", "clientSecret": "gsecret"}}}}), 200)
	startURL, _ := h.startTest("google", map[string]any{})
	auth := location(t, h.do("GET", startURL, nil))
	h.expect(h.do("GET", "/_ui/auth/google/callback?"+googleIdP.authorize(t, auth, "gclient", userEmail, nil), nil), 200)

	anon := h.clone()
	if st := anon.state(); len(st.Providers) != 2 || st.Providers[1].ID != "google" || st.Providers[1].Name != "Google" {
		t.Fatalf("providers: %+v", st.Providers)
	}
	auth = location(t, anon.do("GET", "/_ui/auth/google/start", nil))
	location(t, anon.do("GET", "/_ui/auth/google/callback?"+googleIdP.authorize(t, auth, "gclient", userEmail, nil), nil))
	if st := anon.state(); !st.Authenticated || st.User != userEmail {
		t.Fatalf("google login: %+v", st)
	}

	// A flow started for google can't be finished at the oidc callback.
	cross := h.clone()
	auth = location(t, cross.do("GET", "/_ui/auth/google/start", nil))
	back := location(t, cross.do("GET", "/_ui/auth/oidc/callback?"+googleIdP.authorize(t, auth, "gclient", userEmail, nil), nil))
	if back != "/?authError=state_mismatch" {
		t.Fatalf("cross-provider callback: %s", back)
	}
}

func TestGitHubLogin(t *testing.T) {
	gh := newFakeGitHub(t)
	h := newHarness(t, harnessOpt{github: gh.endpoints()})
	h.setup()
	h.expect(h.put(map[string]any{"auth": map[string]any{
		"githubUsers": []string{"octo-cat"},
		"providers":   map[string]any{"github": map[string]any{"clientId": "ghclient", "clientSecret": "ghsecret"}},
	}}), 200)
	startURL, tok := h.startTest("github", map[string]any{})
	auth := location(t, h.do("GET", startURL, nil))
	h.expect(h.do("GET", "/_ui/auth/github/callback?"+gh.authorize(t, auth), nil), 200)
	if h.testStatus("github", tok).Status != "verified" {
		t.Fatal("github test not verified")
	}
	h.expect(h.put(`{"auth":{"mode":"sso"}}`), 200)

	anon := h.clone()
	if st := anon.state(); len(st.Providers) != 1 || st.Providers[0].ID != "github" {
		t.Fatalf("providers %+v", st.Providers)
	}
	auth = location(t, anon.do("GET", "/_ui/auth/github/start?return=/logs", nil))
	if !strings.HasPrefix(auth, gh.srv.URL+"/login/oauth/authorize") {
		t.Fatalf("auth url %s", auth)
	}
	if back := location(t, anon.do("GET", "/_ui/auth/github/callback?"+gh.authorize(t, auth), nil)); back != "/logs" {
		t.Fatalf("return %s", back)
	}
	if st := anon.state(); !st.Authenticated || st.User != "octo@example.com" {
		t.Fatalf("%+v", st)
	}

	// Not in GITHUB_USERS and e-mail not allowed → refused.
	gh.mu.Lock()
	gh.login, gh.email = "stranger", "stranger@example.com"
	gh.mu.Unlock()
	c := h.clone()
	auth = location(t, c.do("GET", "/_ui/auth/github/start", nil))
	if back := location(t, c.do("GET", "/_ui/auth/github/callback?"+gh.authorize(t, auth), nil)); back != "/?authError=user_not_allowed" {
		t.Fatalf("stranger: %s", back)
	}
	// Allowed by e-mail instead.
	h.expect(h.put(map[string]any{"auth": map[string]any{"allowedEmails": []string{"stranger@example.com"}}}), 200)
	c = h.clone()
	auth = location(t, c.do("GET", "/_ui/auth/github/start", nil))
	location(t, c.do("GET", "/_ui/auth/github/callback?"+gh.authorize(t, auth), nil))
	if st := c.state(); !st.Authenticated {
		t.Fatal("allowed e-mail refused")
	}
}

func TestSSOStartWhenDisabled(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	for _, id := range []string{"oidc", "google", "github"} {
		if back := location(t, h.do("GET", "/_ui/auth/"+id+"/start", nil)); back != "/?authError=provider_disabled" {
			t.Fatalf("%s: %s", id, back)
		}
	}
	if h.do("POST", "/_ui/auth/oidc/start", nil, xhr).Code != 405 {
		t.Fatal("POST start allowed")
	}
}
