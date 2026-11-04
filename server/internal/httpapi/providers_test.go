package httpapi

import (
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/bropines/jackett-ui/server/internal/auth/oidc"
	"github.com/bropines/jackett-ui/server/internal/session"
	"github.com/bropines/jackett-ui/server/internal/store"
)

const (
	oidcClient = "jui-client"
	userEmail  = "alice@example.com"
	newEmail   = "new@example.com"
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

// configureOIDC stores the oidc provider for idp (allow-list: userEmail,
// newEmail), verifies it with the test flow and switches its method on
// (next to password).
func configureOIDC(t *testing.T, h *harness, idp *fakeIdP) {
	t.Helper()
	h.expect(h.put(map[string]any{"auth": map[string]any{
		"allowedEmails": []string{userEmail, newEmail},
		"providers":     map[string]any{"oidc": map[string]any{"issuer": idp.srv.URL, "clientId": oidcClient, "clientSecret": "s3cret", "providerName": "Authentik"}},
	}}), 200)
	// Switching the method on before the test login is refused.
	if w := h.put(map[string]any{"auth": map[string]any{"methods": map[string]any{"password": true, "oidc": true}}}); w.Code != 409 || errorCode(w) != "provider_not_ready" {
		t.Fatalf("unverified method: %d %s", w.Code, w.Body)
	}
	startURL, tok := h.startTest("oidc", map[string]any{})
	if st := h.testStatus("oidc", tok); st.Status != "pending" {
		t.Fatalf("status %+v", st)
	}
	sessBefore := h.jar[session.CookieName]
	auth := location(t, h.do("GET", startURL, nil))
	w := h.do("GET", "/_ui/auth/oidc/callback?"+idp.authorize(t, auth, oidcClient, "tester@elsewhere.org", nil), nil)
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
	if n := len(h.store.Get().Users); n != 1 {
		t.Fatalf("test login created a user (%d users)", n)
	}
	h.expect(h.put(map[string]any{"auth": map[string]any{"methods": map[string]any{"password": true, "oidc": true, "google": false, "github": false, "header": false}}}), 200)
}

// ssoLogin runs start → IdP → callback for email on client c and returns
// the final redirect.
func ssoLogin(t *testing.T, c *harness, idp *fakeIdP, start, email string, mutate func(map[string]any)) string {
	t.Helper()
	auth := location(t, c.do("GET", start, nil))
	return location(t, c.do("GET", "/_ui/auth/oidc/callback?"+idp.authorize(t, auth, oidcClient, email, mutate), nil))
}

func TestOIDCLoginEndToEnd(t *testing.T) {
	idp := newFakeIdP(t)
	h := newHarness(t, harnessOpt{})
	h.setup()
	configureOIDC(t, h, idp)

	// The caller kept its password session.
	if st := h.state(); !st.Authenticated || st.User.Username != "admin" {
		t.Fatalf("caller after switch: %+v", st)
	}
	anon := h.clone()
	st := anon.state()
	if len(st.Methods.Providers) != 1 || st.Methods.Providers[0].ID != "oidc" || st.Methods.Providers[0].Name != "Authentik" || !st.Methods.Password {
		t.Fatalf("login page state: %+v", st)
	}
	if !strings.Contains(anon.do("GET", "/", nil).Header().Get("Content-Security-Policy"), "form-action 'self' "+idp.srv.URL) {
		t.Fatal("CSP form-action lacks the issuer")
	}

	// Login: auto-provisioned (allowed e-mail) with the default role.
	auth := location(t, anon.do("GET", "/_ui/auth/oidc/start?return=/search%3Fq%3D1", nil))
	if !strings.HasPrefix(auth, idp.srv.URL+"/authorize") || !strings.Contains(auth, url.QueryEscape("http://ui.test/_ui/auth/oidc/callback")) {
		t.Fatalf("auth url %s", auth)
	}
	if _, ok := anon.jar[oidc.FlowCookie]; !ok {
		t.Fatal("no flow cookie")
	}
	back := location(t, anon.do("GET", "/_ui/auth/oidc/callback?"+idp.authorize(t, auth, oidcClient, userEmail, func(c map[string]any) { c["name"] = "Alice A." }), nil))
	if back != "/search?q=1" {
		t.Fatalf("return to %q", back)
	}
	st = anon.state()
	if !st.Authenticated || st.User.Username != "alice" || st.User.Role != "viewer" || st.User.Name != "Alice A." {
		t.Fatalf("after login: %+v", st.User)
	}
	alice := h.userByName("alice")
	if len(alice.Identities) != 1 || alice.Identities[0].Subject != "sub-"+userEmail || alice.Identities[0].Issuer != idp.srv.URL || alice.Identities[0].Label != userEmail {
		t.Fatalf("identity: %+v", alice.Identities)
	}
	anon.expect(anon.do("GET", "/api/v2.0/indexers", nil), 200)
	anon.expect(anon.do("GET", "/api/v2.0/server/config", nil), 403)

	// The second login is resolved by the linked identity, even after the
	// e-mail was removed from the allow-list.
	h.expect(h.put(map[string]any{"auth": map[string]any{"allowedEmails": []string{newEmail}}}), 200)
	c := h.clone()
	ssoLogin(t, c, idp, "/_ui/auth/oidc/start", userEmail, nil)
	if st := c.state(); st.User == nil || st.User.ID != alice.ID {
		t.Fatalf("linked login: %+v", st.User)
	}
	if n := len(h.store.Get().Users); n != 2 {
		t.Fatalf("users = %d", n)
	}

	// Open redirect attempts end at "/".
	for _, ret := range []string{"https://evil.com", "//evil.com", "/\\evil.com"} {
		if back := ssoLogin(t, h.clone(), idp, "/_ui/auth/oidc/start?return="+url.QueryEscape(ret), userEmail, nil); back != "/" {
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
		{"unverified email", newEmail, func(c map[string]any) { c["email_verified"] = false }, nil, "email_not_verified"},
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
	if n := len(h.store.Get().Users); n != 2 {
		t.Fatalf("refused logins created users: %d", n)
	}
	// Callback without a started flow.
	if back := location(t, h.clone().do("GET", "/_ui/auth/oidc/callback?code=x&state=y", nil)); back != "/?authError=state_mismatch" {
		t.Fatalf("no flow: %s", back)
	}

	// Auto-provisioning off: unknown identities are refused, linked ones work.
	h.expect(h.put(map[string]any{"auth": map[string]any{"autoProvision": map[string]any{"enabled": false}}}), 200)
	if back := ssoLogin(t, h.clone(), idp, "/_ui/auth/oidc/start", newEmail, nil); back != "/?authError=user_not_allowed" {
		t.Fatalf("auto-provision off: %s", back)
	}
	if back := ssoLogin(t, h.clone(), idp, "/_ui/auth/oidc/start", userEmail, nil); back != "/" {
		t.Fatalf("linked user refused: %s", back)
	}
	// A disabled user's identity is refused (and gets no new account).
	h.expect(h.do("PATCH", "/_ui/api/users/"+alice.ID, map[string]any{"disabled": true}), 200)
	if back := ssoLogin(t, h.clone(), idp, "/_ui/auth/oidc/start", userEmail, nil); back != "/?authError=user_disabled" {
		t.Fatalf("disabled: %s", back)
	}
	c.expect(c.do("GET", "/api/v2.0/indexers", nil), 401) // alice's session died
	h.expect(h.do("PATCH", "/_ui/api/users/"+alice.ID, map[string]any{"disabled": false}), 200)

	// Changing the secret resets verified: the button disappears.
	h.expect(h.put(map[string]any{"auth": map[string]any{"providers": map[string]any{"oidc": map[string]any{"clientSecret": "rotated"}}}}), 200)
	if st := anon.clone().state(); len(st.Methods.Providers) != 0 {
		t.Fatalf("unverified provider still offered: %+v", st.Methods.Providers)
	}
	if back := location(t, h.clone().do("GET", "/_ui/auth/oidc/start", nil)); back != "/?authError=provider_disabled" {
		t.Fatalf("start of unverified provider: %s", back)
	}
	// Sessions made with oidc die when the oidc method is switched off.
	h.expect(h.put(map[string]any{"auth": map[string]any{"providers": map[string]any{"oidc": map[string]any{"clientSecret": "s3cret"}}}}), 200)
	c2 := h.clone()
	ssoLogin(t, c2, idp, "/_ui/auth/oidc/start", userEmail, nil)
	c2.expect(c2.do("GET", "/api/v2.0/indexers", nil), 200)
	h.expect(h.put(map[string]any{"auth": map[string]any{"methods": map[string]any{"password": true, "oidc": false}}}), 200)
	c2.expect(c2.do("GET", "/api/v2.0/indexers", nil), 401)
}

func TestSSOOnlyLockOutAndLinking(t *testing.T) {
	idp := newFakeIdP(t)
	h := newHarness(t, harnessOpt{})
	h.setup()
	configureOIDC(t, h, idp)
	adminID := h.userByName("admin").ID
	ssoOnly := map[string]any{"auth": map[string]any{"methods": map[string]any{"password": false, "oidc": true}}}

	// The admin has no linked identity: SSO-only would lock all admins out.
	w := h.put(ssoOnly)
	if w.Code != 409 || errorCode(w) != "would_lock_out" || !strings.Contains(w.Body.String(), `"field":"auth.methods"`) {
		t.Fatalf("lock-out: %d %s", w.Code, w.Body)
	}

	// Link: needs a session.
	if back := location(t, h.clone().do("GET", "/_ui/auth/oidc/start?link=1", nil)); back != "/?authError=unauthorized" {
		t.Fatalf("link without session: %s", back)
	}
	// Link the admin's identity (allow-lists not needed for linking).
	back := ssoLogin(t, h, idp, "/_ui/auth/oidc/start?link=1&return=/profile", "boss@corp.example", nil)
	if back != "/profile?linked=oidc" {
		t.Fatalf("link: %s", back)
	}
	admin := h.userByName("admin")
	if len(admin.Identities) != 1 || admin.Identities[0].Label != "boss@corp.example" {
		t.Fatalf("identities: %+v", admin.Identities)
	}
	// Linking again is idempotent; a second identity of the same provider is refused.
	if back := ssoLogin(t, h, idp, "/_ui/auth/oidc/start?link=1", "boss@corp.example", nil); back != "/profile?linked=oidc" {
		t.Fatalf("relink: %s", back)
	}
	if back := ssoLogin(t, h, idp, "/_ui/auth/oidc/start?link=1", "other@corp.example", nil); back != "/profile?authError=provider_already_linked" {
		t.Fatalf("second identity: %s", back)
	}
	// An identity that belongs to someone else: identity_in_use.
	viewerID := h.createUser("viewer1", "viewer", "viewer-password")
	v := h.as("viewer1", "viewer-password")
	if back := ssoLogin(t, v, idp, "/_ui/auth/oidc/start?link=1&return=/profile", "boss@corp.example", nil); back != "/profile?authError=identity_in_use" {
		t.Fatalf("identity in use: %s", back)
	}
	// Wrong session: the flow was started by viewer1, finished after the
	// viewer's sessions were ended.
	auth := location(t, v.do("GET", "/_ui/auth/oidc/start?link=1", nil))
	h.expect(h.do("POST", "/_ui/api/users/"+viewerID+"/logout", nil, xhr), 204)
	if back := location(t, v.do("GET", "/_ui/auth/oidc/callback?"+idp.authorize(t, auth, oidcClient, "v@corp.example", nil), nil)); back != "/profile?authError=wrong_session" {
		t.Fatalf("wrong session: %s", back)
	}
	// Another user's session finishing someone else's flow (flow cookie copied).
	v = h.as("viewer1", "viewer-password")
	auth = location(t, v.do("GET", "/_ui/auth/oidc/start?link=1", nil))
	thief := h.clone()
	thief.jar[oidc.FlowCookie] = v.jar[oidc.FlowCookie] // admin's session + viewer's flow
	thief.jar[session.CookieName] = h.jar[session.CookieName]
	if back := location(t, thief.do("GET", "/_ui/auth/oidc/callback?"+idp.authorize(t, auth, oidcClient, "v2@corp.example", nil), nil)); back != "/profile?authError=wrong_session" {
		t.Fatalf("other session: %s", back)
	}
	if u := h.userByName("viewer1"); len(u.Identities) != 0 {
		t.Fatal("identity linked through a wrong session")
	}

	// Now SSO-only is allowed; the password session dies (method off).
	h.expect(h.put(ssoOnly), 200)
	h.expect(h.do("GET", "/_ui/api/settings", nil), 401)
	if st := h.clone().state(); st.Methods.Password {
		t.Fatal("password still offered")
	}
	adm := h.clone()
	ssoLogin(t, adm, idp, "/_ui/auth/oidc/start", "boss@corp.example", nil)
	if st := adm.state(); st.User == nil || st.User.ID != adminID || st.User.Role != "admin" {
		t.Fatalf("sso admin: %+v", st.User)
	}
	// Unlinking the only way in: would_lock_out.
	if w := adm.do("DELETE", "/_ui/api/me/identities/oidc", nil, xhr); w.Code != 409 || errorCode(w) != "would_lock_out" {
		t.Fatalf("unlink: %d %s", w.Code, w.Body)
	}
	// Rotating the secret (unverified) would lock out too.
	if w := adm.put(map[string]any{"auth": map[string]any{"providers": map[string]any{"oidc": map[string]any{"clientSecret": "rotated"}}}}); w.Code != 409 || errorCode(w) != "would_lock_out" {
		t.Fatalf("secret rotation: %d %s", w.Code, w.Body)
	}
	// With a password set and the method back on, unlinking works.
	adm.expect(adm.put(map[string]any{"auth": map[string]any{"methods": map[string]any{"password": true, "oidc": true}}}), 200)
	adm.expect(adm.do("DELETE", "/_ui/api/me/identities/oidc", nil, xhr), 204)
	adm.expect(adm.do("DELETE", "/_ui/api/me/identities/oidc", nil, xhr), 404)
}

func TestSSOBootstrapFirstAdmin(t *testing.T) {
	idp := newFakeIdP(t)
	// SSO-only from env: no password user, no setup wizard needed.
	h := newHarness(t, harnessOpt{env: map[string]string{
		"AUTH_METHODS": "oidc", "OIDC_ISSUER": idp.srv.URL, "OIDC_CLIENT_ID": oidcClient, "OIDC_CLIENT_SECRET": "s3cret",
		"AUTH_ALLOWED_EMAILS": userEmail + "," + newEmail,
	}})
	st := h.state()
	if st.SetupRequired || len(st.Methods.Providers) != 1 || st.Methods.Password {
		t.Fatalf("%+v", st)
	}
	h.expect(h.do("GET", "/api/v2.0/indexers", nil), 401)
	// Not allowed → no account, still no users.
	if back := ssoLogin(t, h.clone(), idp, "/_ui/auth/oidc/start", "mallory@example.com", nil); back != "/?authError=user_not_allowed" {
		t.Fatalf("mallory: %s", back)
	}
	// The first allowed login becomes admin.
	ssoLogin(t, h, idp, "/_ui/auth/oidc/start", userEmail, nil)
	if st := h.state(); st.User == nil || st.User.Role != "admin" || st.SetupRequired {
		t.Fatalf("bootstrap: %+v", st)
	}
	// The next one gets the default role.
	c := h.clone()
	ssoLogin(t, c, idp, "/_ui/auth/oidc/start", newEmail, nil)
	if st := c.state(); st.User == nil || st.User.Role != "viewer" {
		t.Fatalf("second: %+v", st.User)
	}
	// Setup wizard is closed now.
	if w := h.clone().do("POST", "/_ui/api/auth/setup", map[string]string{"password": "whatever-123"}); w.Code != 409 {
		t.Fatalf("setup after bootstrap: %d", w.Code)
	}
}

func TestAdminEmailsAndDefaultRole(t *testing.T) {
	idp := newFakeIdP(t)
	h := newHarness(t, harnessOpt{env: map[string]string{
		"AUTH_METHODS": "password,oidc", "OIDC_ISSUER": idp.srv.URL, "OIDC_CLIENT_ID": oidcClient, "OIDC_CLIENT_SECRET": "s3cret",
		"AUTH_ADMIN_EMAILS": "Boss@Example.com", "AUTH_DEFAULT_ROLE": "editor", "OIDC_ALLOWED_GROUPS": "media",
		"AUTH_PASSWORD": adminPW, // an admin exists already: no SSO bootstrap, and the setup wizard is closed with SSO on
	}})
	boss := h.clone()
	ssoLogin(t, boss, idp, "/_ui/auth/oidc/start", "boss@example.com", func(c map[string]any) { c["groups"] = []string{} })
	if st := boss.state(); st.User == nil || st.User.Role != "admin" {
		t.Fatalf("admin e-mail: %+v", st.User)
	}
	// Unverified admin e-mail: no elevation, refused (no other list matches).
	if back := ssoLogin(t, h.clone(), idp, "/_ui/auth/oidc/start", "Boss@example.com", func(c map[string]any) {
		c["email_verified"] = false
		c["sub"] = "other-sub"
		c["groups"] = []string{}
	}); back != "/?authError=email_not_verified" {
		t.Fatalf("unverified admin e-mail: %s", back)
	}
	// Group member: default role (editor).
	ed := h.clone()
	ssoLogin(t, ed, idp, "/_ui/auth/oidc/start", "someone@example.com", func(c map[string]any) { c["groups"] = []string{"Media"} })
	if st := ed.state(); st.User == nil || st.User.Role != "editor" || st.User.Username != "someone" {
		t.Fatalf("group: %+v", st.User)
	}
	ed.expect(ed.do("GET", "/api/v2.0/indexers/x/config", nil), 200)
	ed.expect(ed.do("GET", "/api/v2.0/server/config", nil), 403)
}

func TestInviteViaProvider(t *testing.T) {
	idp := newFakeIdP(t)
	h := newHarness(t, harnessOpt{})
	h.setup()
	configureOIDC(t, h, idp)
	w := h.do("POST", "/_ui/api/invites", map[string]any{"name": "Thero", "role": "editor"})
	h.expect(w, 201)
	inv := decode[createdInvite](t, w)
	if !strings.HasPrefix(inv.URL, "http://ui.test/invite/") || inv.Token == "" || !strings.HasSuffix(inv.URL, inv.Token) {
		t.Fatalf("invite: %+v", inv)
	}
	// Allow-lists are not required: the invite is the permission.
	c := h.clone()
	back := ssoLogin(t, c, idp, "/_ui/auth/oidc/start?invite="+inv.Token, "stranger@outside.example", nil)
	if back != "/" {
		t.Fatalf("invite accept: %s", back)
	}
	st := c.state()
	if st.User == nil || st.User.Role != "editor" || st.User.Name != "Thero" || st.User.Username != "stranger" {
		t.Fatalf("invited user: %+v", st.User)
	}
	// Single use.
	if back := location(t, h.clone().do("GET", "/_ui/auth/oidc/start?invite="+inv.Token, nil)); back != "/?authError=invite_not_found" {
		t.Fatalf("reuse: %s", back)
	}
	h.expect(h.clone().do("GET", "/_ui/api/invites/"+inv.Token, nil), 404)
	// An identity that already has an account can't take an invite.
	w = h.do("POST", "/_ui/api/invites", map[string]any{"name": "", "role": "viewer"})
	inv2 := decode[createdInvite](t, w)
	if back := ssoLogin(t, h.clone(), idp, "/_ui/auth/oidc/start?invite="+inv2.Token, "stranger@outside.example", nil); back != "/invite/"+inv2.Token+"?authError=identity_in_use" {
		t.Fatalf("identity in use: %s", back)
	}
	// The invite is still there after that failure.
	h.expect(h.clone().do("GET", "/_ui/api/invites/"+inv2.Token, nil), 200)
	// Provider method off: not offered for invites.
	h.expect(h.put(map[string]any{"auth": map[string]any{"methods": map[string]any{"password": true, "oidc": false}}}), 200)
	if back := location(t, h.clone().do("GET", "/_ui/auth/oidc/start?invite="+inv2.Token, nil)); back != "/invite/"+inv2.Token+"?authError=provider_disabled" {
		t.Fatalf("method off: %s", back)
	}
}

func TestOIDCTestFlowFailures(t *testing.T) {
	idp := newFakeIdP(t)
	h := newHarness(t, harnessOpt{})
	h.setup()

	// Unsaved form values are tested; a failing IdP answer fails the test.
	startURL, tok := h.startTest("oidc", map[string]any{"issuer": idp.srv.URL, "clientId": oidcClient, "clientSecret": "s3cret"})
	auth := location(t, h.do("GET", startURL, nil))
	w := h.do("GET", "/_ui/auth/oidc/callback?"+idp.authorize(t, auth, oidcClient, userEmail, func(c map[string]any) { c["nonce"] = "x" }), nil)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "nonce_mismatch") {
		t.Fatalf("failed test page: %d %s", w.Code, w.Body)
	}
	st := h.testStatus("oidc", tok)
	if st.Status != "failed" || st.Error != "nonce_mismatch" || st.Message == "" {
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
	h.expect(h.do("GET", "/_ui/api/settings/providers/oidc/test/unknown", nil), 404)
	if w := h.do("GET", "/_ui/auth/oidc/start?test=unknown", nil); w.Code != 400 {
		t.Fatalf("unknown test token start: %d", w.Code)
	}
	// The test endpoints are protected and admin-only.
	h.clone().expect(h.clone().do("POST", "/_ui/api/settings/providers/oidc/test", map[string]any{}), 401)
	h.createUser("ed", "editor", "editor-password")
	ed := h.as("ed", "editor-password")
	ed.expect(ed.do("POST", "/_ui/api/settings/providers/oidc/test", map[string]any{}), 403)
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
	h.expect(h.put(map[string]any{"auth": map[string]any{"methods": map[string]any{"password": true, "oidc": true, "google": true}}}), 200)

	anon := h.clone()
	if st := anon.state(); len(st.Methods.Providers) != 2 || st.Methods.Providers[1].ID != "google" || st.Methods.Providers[1].Name != "Google" {
		t.Fatalf("providers: %+v", st.Methods.Providers)
	}
	auth = location(t, anon.do("GET", "/_ui/auth/google/start", nil))
	location(t, anon.do("GET", "/_ui/auth/google/callback?"+googleIdP.authorize(t, auth, "gclient", userEmail, nil), nil))
	if st := anon.state(); !st.Authenticated || st.User.Username != "alice" {
		t.Fatalf("google login: %+v", st)
	}
	// Same e-mail at oidc is another identity → another account (keys are
	// provider+issuer+subject, never the e-mail).
	c := h.clone()
	ssoLogin(t, c, oidcIdP, "/_ui/auth/oidc/start", userEmail, nil)
	if st := c.state(); st.User.Username != "alice-2" {
		t.Fatalf("oidc login: %+v", st.User)
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
	h.expect(h.put(map[string]any{"auth": map[string]any{"methods": map[string]any{"password": true, "github": true}}}), 200)

	anon := h.clone()
	if st := anon.state(); len(st.Methods.Providers) != 1 || st.Methods.Providers[0].ID != "github" {
		t.Fatalf("providers %+v", st.Methods.Providers)
	}
	auth = location(t, anon.do("GET", "/_ui/auth/github/start?return=/logs", nil))
	if !strings.HasPrefix(auth, gh.srv.URL+"/login/oauth/authorize") {
		t.Fatalf("auth url %s", auth)
	}
	if back := location(t, anon.do("GET", "/_ui/auth/github/callback?"+gh.authorize(t, auth), nil)); back != "/logs" {
		t.Fatalf("return %s", back)
	}
	st := anon.state()
	if !st.Authenticated || st.User.Username != "octo-cat" || st.User.Name != "Octo" {
		t.Fatalf("%+v", st.User)
	}
	u := h.userByName("octo-cat")
	if u.Identities[0].Issuer != "https://github.com" || u.Identities[0].Subject != "42" {
		t.Fatalf("github identity: %+v", u.Identities)
	}

	// Renamed login, same id: still the same account (subject = numeric id).
	gh.mu.Lock()
	gh.login, gh.email = "stranger", "stranger@example.com"
	gh.mu.Unlock()
	c := h.clone()
	auth = location(t, c.do("GET", "/_ui/auth/github/start", nil))
	location(t, c.do("GET", "/_ui/auth/github/callback?"+gh.authorize(t, auth), nil))
	if st := c.state(); st.User == nil || st.User.ID != u.ID {
		t.Fatalf("renamed login: %+v", st.User)
	}
	// Unlinked + not allowed → refused; allowed by e-mail → new account.
	h.expect(h.do("DELETE", "/_ui/api/users/"+u.ID+"/identities/github", nil, xhr), 204)
	c = h.clone()
	auth = location(t, c.do("GET", "/_ui/auth/github/start", nil))
	if back := location(t, c.do("GET", "/_ui/auth/github/callback?"+gh.authorize(t, auth), nil)); back != "/?authError=user_not_allowed" {
		t.Fatalf("stranger: %s", back)
	}
	h.expect(h.put(map[string]any{"auth": map[string]any{"allowedEmails": []string{"stranger@example.com"}}}), 200)
	c = h.clone()
	auth = location(t, c.do("GET", "/_ui/auth/github/start", nil))
	location(t, c.do("GET", "/_ui/auth/github/callback?"+gh.authorize(t, auth), nil))
	if st := c.state(); !st.Authenticated || st.User.Username != "stranger" {
		t.Fatalf("allowed e-mail: %+v", st.User)
	}
}

func TestSSOStartWhenDisabled(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	for _, id := range []string{"oidc", "google", "github"} {
		if back := location(t, h.do("GET", "/_ui/auth/"+id+"/start", nil)); back != "/?authError=provider_disabled" {
			t.Fatalf("%s: %s", id, back)
		}
		if back := location(t, h.do("GET", "/_ui/auth/"+id+"/start?link=1", nil)); back != "/profile?authError=provider_disabled" {
			t.Fatalf("%s link: %s", id, back)
		}
	}
	if h.do("POST", "/_ui/auth/oidc/start", nil, xhr).Code != 405 {
		t.Fatal("POST start allowed")
	}
	_ = store.RoleAdmin
}

// With SSO on, an instance without users must not offer the password setup
// wizard to anonymous visitors (the first visitor would get the panel).
func TestNoSetupWizardWithSSO(t *testing.T) {
	idp := newFakeIdP(t)
	h := newHarness(t, harnessOpt{env: map[string]string{
		"AUTH_METHODS": "password,oidc", "OIDC_ISSUER": idp.srv.URL, "OIDC_CLIENT_ID": oidcClient, "OIDC_CLIENT_SECRET": "s3cret",
		"AUTH_ALLOWED_EMAILS": userEmail,
	}})
	if st := h.state(); st.SetupRequired {
		t.Fatalf("setup wizard offered with SSO on: %+v", st)
	}
	if w := h.do("POST", "/_ui/api/auth/setup", map[string]string{"password": "takeover-123456"}); w.Code != 409 {
		t.Fatalf("anonymous setup with SSO on: %d", w.Code)
	}
}
