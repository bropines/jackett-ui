package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/bropines/jackett-ui/server/internal/session"
	"github.com/bropines/jackett-ui/server/internal/store"
)

type field struct {
	Value  any    `json:"value"`
	Locked bool   `json:"locked"`
	Env    string `json:"env"`
}

type settingsResp struct {
	Auth struct {
		Mode             field `json:"mode"`
		PasswordSet      field `json:"passwordSet"`
		PasswordFallback field `json:"passwordFallback"`
		AllowedEmails    field `json:"allowedEmails"`
		GitHubUsers      field `json:"githubUsers"`
		Providers        map[string]struct {
			Issuer          field  `json:"issuer"`
			ClientID        field  `json:"clientId"`
			ClientSecretSet field  `json:"clientSecretSet"`
			ProviderName    field  `json:"providerName"`
			Scopes          field  `json:"scopes"`
			RedirectURL     string `json:"redirectUrl"`
			Verified        bool   `json:"verified"`
			Enabled         bool   `json:"enabled"`
		} `json:"providers"`
		Header struct {
			Name    field `json:"name"`
			Trusted field `json:"trusted"`
		} `json:"header"`
	} `json:"auth"`
	PublicURL  field `json:"publicUrl"`
	SessionTTL field `json:"sessionTtl"`
}

func (h *harness) settings() settingsResp {
	h.t.Helper()
	w := h.do("GET", "/_ui/api/settings", nil)
	h.expect(w, 200)
	return decode[settingsResp](h.t, w)
}

func TestSettingsGetLockedAndNoSecrets(t *testing.T) {
	h := newHarness(t, harnessOpt{
		env: map[string]string{"OIDC_ISSUER": "https://auth.example.com/app/", "OIDC_CLIENT_ID": "envclient", "OIDC_CLIENT_SECRET": "env-secret-value", "SESSION_TTL": "24h"},
		settings: func(s *store.Settings) {
			s.Auth.Providers.Google = store.Provider{ClientID: "gid", ClientSecret: "google-secret-value"}
			s.Auth.AllowedEmails = []string{"me@example.com"}
		},
	})
	h.setup()
	w := h.do("GET", "/_ui/api/settings", nil)
	h.expect(w, 200)
	raw := w.Body.String()
	for _, secret := range []string{"env-secret-value", "google-secret-value", "$2a$", adminPW, jackettPW} {
		if strings.Contains(raw, secret) {
			t.Fatalf("settings leak %q: %s", secret, raw)
		}
	}
	s := decode[settingsResp](t, w)
	o := s.Auth.Providers["oidc"]
	if !o.Issuer.Locked || o.Issuer.Env != "OIDC_ISSUER" || o.ClientID.Value != "envclient" || !o.ClientSecretSet.Locked || o.ClientSecretSet.Value != true {
		t.Fatalf("oidc: %+v", o)
	}
	if o.ProviderName.Locked || o.ProviderName.Value != "SSO" || !o.Enabled || !o.Verified /* all from env */ {
		t.Fatalf("oidc name/flags: %+v", o)
	}
	if o.RedirectURL != "http://ui.test/_ui/auth/oidc/callback" {
		t.Fatalf("redirect %s", o.RedirectURL)
	}
	g := s.Auth.Providers["google"]
	if g.ClientSecretSet.Value != true || g.ClientSecretSet.Locked || g.Verified || g.RedirectURL != "http://ui.test/_ui/auth/google/callback" {
		t.Fatalf("google: %+v", g)
	}
	if !s.SessionTTL.Locked || s.SessionTTL.Value != "24h" || s.PublicURL.Locked || s.Auth.Mode.Value != "password" {
		t.Fatalf("misc: %+v %+v", s.SessionTTL, s.PublicURL)
	}
	if s.Auth.PasswordSet.Value != true || s.Auth.PasswordSet.Locked {
		t.Fatalf("passwordSet %+v", s.Auth.PasswordSet)
	}
}

func TestSettingsPutRules(t *testing.T) {
	type step struct {
		name  string
		body  string
		code  int
		err   string
		field string
	}
	h := newHarness(t, harnessOpt{env: map[string]string{"OIDC_CLIENT_ID": "envclient", "SESSION_TTL": "24h"}})
	h.setup()
	steps := []step{
		{"empty is fine", `{}`, 200, "", ""},
		{"unknown field", `{"bogus":1}`, 400, "bad_request", ""},
		{"locked field change", `{"auth":{"providers":{"oidc":{"clientId":"other"}}}}`, 409, "locked", "auth.providers.oidc.clientId"},
		{"locked field same value", `{"auth":{"providers":{"oidc":{"clientId":"envclient"}}}}`, 200, "", ""},
		{"locked ttl same duration", `{"sessionTtl":"24h0m0s"}`, 200, "", ""},
		{"locked ttl change", `{"sessionTtl":"48h"}`, 409, "locked", "sessionTtl"},
		{"bad mode", `{"auth":{"mode":"ldap"}}`, 400, "invalid_value", "auth.mode"},
		{"none needs confirm", `{"auth":{"mode":"none"}}`, 400, "confirm_required", "auth.mode"},
		{"header needs trusted", `{"auth":{"mode":"header"}}`, 400, "header_trusted_required", "auth.header.trusted"},
		{"bad cidr", `{"auth":{"header":{"trusted":["10.0.0.0/99"]}}}`, 400, "invalid_value", "auth.header.trusted"},
		{"bad header name", `{"auth":{"header":{"name":"Bad Header"}}}`, 400, "invalid_value", "auth.header.name"},
		{"header lockout (caller not via proxy)", `{"auth":{"mode":"header","header":{"trusted":["10.0.0.0/8"]}}}`, 409, "header_lockout", ""},
		{"sso unverified", `{"auth":{"mode":"sso"}}`, 409, "sso_not_ready", ""},
		{"oidc-only field on google", `{"auth":{"providers":{"google":{"issuer":"https://x"}}}}`, 400, "invalid_value", "auth.providers.google.issuer"},
		{"bad issuer", `{"auth":{"providers":{"oidc":{"issuer":"ftp://x"}}}}`, 400, "invalid_value", "auth.providers.oidc.issuer"},
		{"bad public url", `{"publicUrl":"https://x.com/sub"}`, 400, "invalid_value", "publicUrl"},
		{"good public url", `{"publicUrl":"https://Jackett.Example.com/"}`, 200, "", ""},
		{"wrong current password", `{"password":{"current":"nope-nope","new":"new-password-1"}}`, 403, "invalid_credentials", "password.current"},
		{"short new password", `{"password":{"current":"` + adminPW + `","new":"short"}}`, 400, "password_too_short", "password.new"},
		{"password twice", `{"password":{"current":"a","new":"b"},"auth":{"password":{"current":"a","new":"b"}}}`, 400, "invalid_value", "password"},
	}
	for _, s := range steps {
		t.Run(s.name, func(t *testing.T) {
			w := h.do("PUT", "/_ui/api/settings", s.body, hdr("Content-Type", "application/json"))
			if w.Code != s.code || (s.err != "" && errorCode(w) != s.err) {
				t.Fatalf("got %d %s", w.Code, w.Body)
			}
			if s.field != "" {
				var b map[string]string
				_ = json.Unmarshal(w.Body.Bytes(), &b)
				if b["field"] != s.field {
					t.Fatalf("field %q, want %q", b["field"], s.field)
				}
			}
			if s.code >= 400 {
				var b map[string]string
				_ = json.Unmarshal(w.Body.Bytes(), &b)
				if b["message"] == "" {
					t.Fatal("error without message")
				}
			}
		})
	}
	if got := h.settings().PublicURL.Value; got != "https://jackett.example.com" {
		t.Fatalf("publicUrl normalised to %v", got)
	}
}

func TestSettingsSecretsAndLists(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	h.expect(h.put(map[string]any{"auth": map[string]any{
		"allowedEmails": []string{" a@x.com ", "", "a@x.com", "b@x.com"},
		"providers":     map[string]any{"github": map[string]any{"clientId": "gh", "clientSecret": "gh-secret"}},
	}}), 200)
	st := h.store.Get()
	if strings.Join(st.Auth.AllowedEmails, ",") != "a@x.com,b@x.com" || st.Auth.Providers.GitHub.ClientSecret != "gh-secret" {
		t.Fatalf("stored: %+v", st.Auth)
	}
	// "" keeps the secret, null clears it.
	h.expect(h.put(map[string]any{"auth": map[string]any{"providers": map[string]any{"github": map[string]any{"clientSecret": ""}}}}), 200)
	if h.store.Get().Auth.Providers.GitHub.ClientSecret != "gh-secret" {
		t.Fatal("empty secret cleared the stored one")
	}
	h.expect(h.put(`{"auth":{"providers":{"github":{"clientSecret":null}}}}`), 200)
	if h.store.Get().Auth.Providers.GitHub.ClientSecret != "" {
		t.Fatal("null did not clear the secret")
	}
	h.expect(h.put(`{"auth":{"allowedEmails":null}}`), 200)
	if len(h.store.Get().Auth.AllowedEmails) != 0 {
		t.Fatal("null did not clear the list")
	}
}

func TestPasswordChangeBumpsEpoch(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	other := h.clone()
	other.expect(other.login(adminPW), 204)
	old := h.jar[session.CookieName]
	epoch := h.store.Get().AuthEpoch

	w := h.put(map[string]any{"password": map[string]string{"current": adminPW, "new": "brand-new-pass"}})
	h.expect(w, 200)
	if h.store.Get().AuthEpoch != epoch+1 {
		t.Fatal("epoch not bumped")
	}
	if h.jar[session.CookieName] == old {
		t.Fatal("caller's cookie not re-issued")
	}
	h.expect(h.do("GET", "/_ui/api/settings", nil), 200)         // caller keeps access
	other.expect(other.do("GET", "/_ui/api/settings", nil), 401) // other sessions die
	other.expect(other.login(adminPW), 401)
	other.expect(other.login("brand-new-pass"), 204)
}

func TestEnvPasswordIsLocked(t *testing.T) {
	h := newHarness(t, harnessOpt{env: map[string]string{"AUTH_PASSWORD": "env-password-1"}})
	if h.state().SetupRequired {
		t.Fatal("env password still requires setup")
	}
	h.expect(h.login("env-password-1"), 204)
	w := h.put(map[string]any{"password": map[string]string{"current": "env-password-1", "new": "something-else"}})
	if w.Code != 409 || errorCode(w) != "locked" {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	s := h.settings()
	if !s.Auth.PasswordSet.Locked || s.Auth.PasswordSet.Env != "AUTH_PASSWORD" {
		t.Fatalf("%+v", s.Auth.PasswordSet)
	}
	// AUTH_PASSWORD never reaches the disk.
	if strings.Contains(string(mustJSON(h.store.Get())), "$2a$") {
		t.Fatal("env password hash written to the settings file")
	}
	// Mode locked by env.
	h2 := newHarness(t, harnessOpt{env: map[string]string{"AUTH_MODE": "password", "AUTH_PASSWORD": "env-password-1"}})
	h2.expect(h2.login("env-password-1"), 204)
	if w := h2.put(`{"auth":{"mode":"none"},"confirm":true}`); w.Code != 409 || errorCode(w) != "locked" {
		t.Fatalf("locked mode: %d %s", w.Code, w.Body)
	}
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }

func TestModeSwitches(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	anon := h.clone()

	// → none (confirmed): everyone is in; the caller's cookie is cleared.
	h.expect(h.put(`{"auth":{"mode":"none"},"confirm":true}`), 200)
	if st := anon.state(); !st.Authenticated || st.Mode != "none" {
		t.Fatalf("%+v", st)
	}
	// → password: password exists, caller gets an admin session.
	epoch := h.store.Get().AuthEpoch
	h.expect(h.put(`{"auth":{"mode":"password"}}`), 200)
	if h.store.Get().AuthEpoch != epoch+1 {
		t.Fatal("mode change did not bump epoch")
	}
	if st := h.state(); !st.Authenticated || st.User != "admin" {
		t.Fatalf("caller lost access: %+v", st)
	}
	anon.expect(anon.do("GET", "/_ui/api/settings", nil), 401)

	// → header from the trusted proxy with the header: allowed.
	via := h.clone()
	via.jar = h.jar
	via.remote = "10.0.0.5:1"
	w := via.put(`{"auth":{"mode":"header","header":{"trusted":["10.0.0.0/8"],"name":"X-User"}}}`, hdr("X-User", "bob"))
	via.expect(w, 200)
	via.expect(via.do("GET", "/_ui/api/settings", nil, hdr("X-User", "bob")), 200)
	h.expect(h.do("GET", "/_ui/api/settings", nil), 401) // direct, no proxy
}
