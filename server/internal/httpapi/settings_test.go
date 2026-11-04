package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/bropines/jackett-ui/server/internal/store"
)

type field struct {
	Value  any    `json:"value"`
	Locked bool   `json:"locked"`
	Env    string `json:"env"`
}

type settingsResp struct {
	Auth struct {
		Methods       map[string]field `json:"methods"`
		Disabled      field            `json:"disabled"`
		AutoProvision struct {
			Enabled field `json:"enabled"`
			Role    field `json:"role"`
		} `json:"autoProvision"`
		AllowedEmails field `json:"allowedEmails"`
		AdminEmails   field `json:"adminEmails"`
		GitHubUsers   field `json:"githubUsers"`
		Providers     map[string]struct {
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
		env: map[string]string{"OIDC_ISSUER": "https://auth.example.com/app/", "OIDC_CLIENT_ID": "envclient", "OIDC_CLIENT_SECRET": "env-secret-value",
			"SESSION_TTL": "24h", "AUTH_ADMIN_EMAILS": "boss@example.com"},
		settings: func(s *store.Settings) {
			s.Auth.Providers.Google = store.Provider{ClientID: "gid", ClientSecret: "google-secret-value"}
			s.Auth.AllowedEmails = []string{"me@example.com"}
		},
	})
	h.setup()
	h.newToken("t")
	w := h.do("GET", "/_ui/api/settings", nil)
	h.expect(w, 200)
	raw := w.Body.String()
	for _, secret := range []string{"env-secret-value", "google-secret-value", "$2a$", adminPW, jackettPW, key, "jui_"} {
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
	if !s.SessionTTL.Locked || s.SessionTTL.Value != "24h" || s.PublicURL.Locked {
		t.Fatalf("misc: %+v %+v", s.SessionTTL, s.PublicURL)
	}
	if len(s.Auth.Methods) != 5 || s.Auth.Methods["password"].Value != true || s.Auth.Methods["oidc"].Value != false || s.Auth.Methods["header"].Locked {
		t.Fatalf("methods: %+v", s.Auth.Methods)
	}
	if s.Auth.Disabled.Value != false || s.Auth.AutoProvision.Enabled.Value != true || s.Auth.AutoProvision.Role.Value != "viewer" {
		t.Fatalf("disabled/autoProvision: %+v %+v", s.Auth.Disabled, s.Auth.AutoProvision)
	}
	if !s.Auth.AdminEmails.Locked || s.Auth.AdminEmails.Env != "AUTH_ADMIN_EMAILS" {
		t.Fatalf("admin emails: %+v", s.Auth.AdminEmails)
	}
	// Methods locked as a block by AUTH_METHODS.
	h2 := newHarness(t, harnessOpt{env: map[string]string{"AUTH_METHODS": "password", "AUTH_DEFAULT_ROLE": "editor"}})
	h2.setup()
	s2 := h2.settings()
	for id, f := range s2.Auth.Methods {
		if !f.Locked || f.Env != "AUTH_METHODS" {
			t.Fatalf("%s: %+v", id, f)
		}
	}
	if !s2.Auth.AutoProvision.Role.Locked || s2.Auth.AutoProvision.Role.Value != "editor" {
		t.Fatalf("role: %+v", s2.Auth.AutoProvision.Role)
	}
	if w := h2.put(`{"auth":{"methods":{"password":true,"oidc":true}}}`); w.Code != 409 || errorCode(w) != "locked" {
		t.Fatalf("locked methods: %d %s", w.Code, w.Body)
	}
	h2.expect(h2.put(`{"auth":{"methods":{"password":true}}}`), 200) // same value is fine
	if w := h2.put(`{"auth":{"autoProvision":{"role":"admin"}}}`); w.Code != 409 || errorCode(w) != "locked" {
		t.Fatalf("locked role: %d", w.Code)
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
		{"v0.2 mode is gone", `{"auth":{"mode":"password"}}`, 400, "bad_request", ""},
		{"v0.2 password is gone", `{"password":{"current":"a","new":"b"}}`, 400, "bad_request", ""},
		{"locked field change", `{"auth":{"providers":{"oidc":{"clientId":"other"}}}}`, 409, "locked", "auth.providers.oidc.clientId"},
		{"locked field same value", `{"auth":{"providers":{"oidc":{"clientId":"envclient"}}}}`, 200, "", ""},
		{"locked ttl same duration", `{"sessionTtl":"24h0m0s"}`, 200, "", ""},
		{"locked ttl change", `{"sessionTtl":"48h"}`, 409, "locked", "sessionTtl"},
		{"disable needs confirm", `{"auth":{"disabled":true}}`, 400, "confirm_required", "auth.disabled"},
		{"header needs trusted", `{"auth":{"methods":{"password":true,"header":true}}}`, 400, "header_trusted_required", "auth.header.trusted"},
		{"bad cidr", `{"auth":{"header":{"trusted":["10.0.0.0/99"]}}}`, 400, "invalid_value", "auth.header.trusted"},
		{"bad header name", `{"auth":{"header":{"name":"Bad Header"}}}`, 400, "invalid_value", "auth.header.name"},
		{"header only, caller not via proxy", `{"auth":{"methods":{"password":false,"header":true},"header":{"trusted":["10.0.0.0/8"]}}}`, 409, "would_lock_out", "auth.methods"},
		{"no method at all", `{"auth":{"methods":{"password":false}}}`, 409, "would_lock_out", "auth.methods"},
		{"unverified provider", `{"auth":{"methods":{"password":true,"google":true}}}`, 409, "provider_not_ready", "auth.methods.google"},
		{"bad role", `{"auth":{"autoProvision":{"role":"root"}}}`, 400, "invalid_value", "auth.autoProvision.role"},
		{"good role", `{"auth":{"autoProvision":{"enabled":false,"role":"Editor"}}}`, 200, "", ""},
		{"admin emails", `{"auth":{"adminEmails":["Boss@x.com"," ",""]}}`, 200, "", ""},
		{"oidc-only field on google", `{"auth":{"providers":{"google":{"issuer":"https://x"}}}}`, 400, "invalid_value", "auth.providers.google.issuer"},
		{"bad issuer", `{"auth":{"providers":{"oidc":{"issuer":"ftp://x"}}}}`, 400, "invalid_value", "auth.providers.oidc.issuer"},
		{"bad public url", `{"publicUrl":"https://x.com/sub"}`, 400, "invalid_value", "publicUrl"},
		{"good public url", `{"publicUrl":"https://Jackett.Example.com/"}`, 200, "", ""},
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
	s := h.settings()
	if s.PublicURL.Value != "https://jackett.example.com" {
		t.Fatalf("publicUrl normalised to %v", s.PublicURL.Value)
	}
	st := h.store.Get().Auth
	if st.AutoProvision.Enabled || st.AutoProvision.Role != "editor" || len(st.AdminEmails) != 1 || st.Methods != (store.Methods{Password: true}) {
		t.Fatalf("stored: %+v", st)
	}
	// Settings are admin-only.
	h.createUser("ed", "editor", "editor-password")
	ed := h.as("ed", "editor-password")
	ed.expect(ed.do("GET", "/_ui/api/settings", nil), 403)
	ed.expect(ed.put(`{}`), 403)
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

func TestDisableLoginAndBack(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	anon := h.clone()
	h.expect(h.put(`{"auth":{"disabled":true},"confirm":true}`), 200)
	if st := anon.state(); !st.Authenticated || !st.Disabled || st.User != nil {
		t.Fatalf("%+v", st)
	}
	anon.expect(anon.do("GET", "/api/v2.0/server/config", nil), 200)
	// Re-enable (as the anonymous admin): the admin has a password → fine.
	anon.expect(anon.put(`{"auth":{"disabled":false}}`), 200)
	anon.expect(anon.do("GET", "/_ui/api/settings", nil), 401)
	h.expect(h.do("GET", "/_ui/api/settings", nil), 200) // the old session is valid again
	// Re-enabling with no usable method for any admin is refused.
	h.expect(h.put(`{"auth":{"disabled":true},"confirm":true}`), 200)
	if w := anon.put(`{"auth":{"disabled":false,"methods":{"password":false}}}`); w.Code != 409 || errorCode(w) != "would_lock_out" {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	// The env lock.
	h2 := newHarness(t, harnessOpt{env: map[string]string{"AUTH_DISABLED": "true"}})
	if w := h2.put(`{"auth":{"disabled":false}}`); w.Code != 409 || errorCode(w) != "locked" {
		t.Fatalf("env lock: %d", w.Code)
	}
}

func TestEnvPasswordIsLocked(t *testing.T) {
	h := newHarness(t, harnessOpt{env: map[string]string{"AUTH_PASSWORD": "env-password-1"}})
	if h.state().SetupRequired {
		t.Fatal("env password still requires setup")
	}
	admin := h.userByName("admin")
	if admin.Role != "admin" || admin.PasswordHash != "" {
		t.Fatalf("env admin: %+v", admin)
	}
	h.expect(h.login("env-password-1"), 204)
	w := h.do("POST", "/_ui/api/me/password", map[string]string{"current": "env-password-1", "new": "something-else"})
	if w.Code != 409 || errorCode(w) != "locked" {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	me := decode[meResponse](t, h.do("GET", "/_ui/api/me", nil))
	if !me.User.PasswordSet || !me.User.PasswordLocked {
		t.Fatalf("me: %+v", me.User)
	}
	if w := h.do("PATCH", "/_ui/api/users/"+admin.ID, map[string]any{"password": "other-password"}); w.Code != 409 || errorCode(w) != "locked" {
		t.Fatalf("admin reset: %d", w.Code)
	}
	if w := h.do("DELETE", "/_ui/api/users/"+admin.ID, nil, xhr); w.Code != 409 || errorCode(w) != "locked" {
		t.Fatalf("delete env admin: %d", w.Code)
	}
	// AUTH_PASSWORD never reaches the disk.
	if strings.Contains(string(mustJSON(h.store.Get())), "$2a$") {
		t.Fatal("env password hash written to the settings file")
	}
	// Restart with the same env: no second admin.
	if err := ensureEnvAdmin(h.srv.env, h.store, h.srv.now()); err != nil || len(h.store.Get().Users) != 1 {
		t.Fatalf("ensure twice: %v %d", err, len(h.store.Get().Users))
	}
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }
