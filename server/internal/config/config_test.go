package config

import (
	"log/slog"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/bropines/jackett-ui/server/internal/auth"
	"github.com/bropines/jackett-ui/server/internal/store"
)

func lookup(m map[string]string) Lookup {
	return func(k string) (string, bool) {
		v, ok := m[k]
		return v, ok
	}
}

func TestParseEnvDefaults(t *testing.T) {
	e, err := ParseEnv(lookup(nil))
	if err != nil {
		t.Fatal(err)
	}
	if e.Listen != ":8080" || e.JackettURL.String() != "http://127.0.0.1:9117" || e.DataDir != "/config" ||
		len(e.TrustedProxies) != 2 || e.AuthMode != "" || e.PasswordHash != "" || e.SessionTTL != 0 ||
		e.LogLevel != slog.LevelInfo || e.AuthReset || e.PublicURL != nil || len(e.Set) != 0 {
		t.Fatalf("unexpected defaults: %+v", e)
	}
}

func TestParseEnvValid(t *testing.T) {
	hash, _ := auth.HashPassword("hunter22hunter")
	cases := []struct {
		name  string
		env   map[string]string
		check func(t *testing.T, e *Env)
	}{
		{"jackett url with path", map[string]string{"JACKETT_URL": "http://jackett:9117/jackett/"}, func(t *testing.T, e *Env) {
			if e.JackettURL.Path != "/jackett" {
				t.Fatalf("path %q", e.JackettURL.Path)
			}
		}},
		{"empty values count as unset", map[string]string{"AUTH_MODE": "", "LISTEN": "  "}, func(t *testing.T, e *Env) {
			if e.AuthMode != "" || e.Listen != ":8080" {
				t.Fatal("empty value was used")
			}
		}},
		{"plain password is hashed", map[string]string{"AUTH_PASSWORD": "s3cret pass"}, func(t *testing.T, e *Env) {
			if e.PasswordVar != "AUTH_PASSWORD" || !auth.CheckPassword(e.PasswordHash, "s3cret pass") {
				t.Fatal("password not hashed")
			}
		}},
		{"hash", map[string]string{"AUTH_PASSWORD_HASH": hash}, func(t *testing.T, e *Env) {
			if e.PasswordHash != hash {
				t.Fatal("hash not taken")
			}
		}},
		{"legacy oidc mode", map[string]string{"AUTH_MODE": "OIDC"}, func(t *testing.T, e *Env) {
			if e.AuthMode != auth.ModeSSO {
				t.Fatalf("mode %q", e.AuthMode)
			}
		}},
		{"header mode", map[string]string{"AUTH_MODE": "header", "AUTH_HEADER_TRUSTED": "172.16.0.0/12, 10.0.0.1"}, func(t *testing.T, e *Env) {
			if len(*e.HeaderTrusted) != 2 {
				t.Fatal("trusted not parsed")
			}
		}},
		{"providers and lists", map[string]string{
			"OIDC_ISSUER": "https://auth.example.com/application/o/jackett/", "OIDC_CLIENT_ID": "abc", "OIDC_CLIENT_SECRET": " sec ",
			"GOOGLE_CLIENT_ID": "g", "GITHUB_CLIENT_ID": "gh", "GITHUB_CLIENT_SECRET": "ghs",
			"AUTH_ALLOWED_EMAILS": "a@x.com, ,b@x.com", "GITHUB_USERS": "Octo", "OIDC_ALLOWED_GROUPS": "admins",
		}, func(t *testing.T, e *Env) {
			if *e.Providers["oidc"].ClientSecret != " sec " {
				t.Fatal("secret must not be trimmed")
			}
			if !slices.Equal(*e.AllowedEmails, []string{"a@x.com", "b@x.com"}) || (*e.GitHubUsers)[0] != "Octo" {
				t.Fatalf("lists: %v %v", *e.AllowedEmails, *e.GitHubUsers)
			}
			if slices.Contains(e.Set, "") {
				t.Fatal("empty var name in Set")
			}
		}},
		{"v0.3 knobs", map[string]string{"AUTH_METHODS": "Password, github", "AUTH_DISABLED": "false", "AUTH_AUTO_PROVISION": "0", "AUTH_DEFAULT_ROLE": "Editor", "AUTH_ADMIN_EMAILS": "boss@x.com"}, func(t *testing.T, e *Env) {
			if *e.Methods != (store.Methods{Password: true, GitHub: true}) || *e.Disabled || *e.AutoProvision || *e.DefaultRole != "editor" || (*e.AdminEmails)[0] != "boss@x.com" {
				t.Fatalf("%+v", e)
			}
		}},
		{"misc", map[string]string{"SESSION_TTL": "24h", "LOG_LEVEL": "debug", "AUTH_RESET": "1", "PUBLIC_URL": "https://J.example.com/", "AUTH_PASSWORD_FALLBACK": "false"}, func(t *testing.T, e *Env) {
			if e.SessionTTL != 24*time.Hour || e.LogLevel != slog.LevelDebug || !e.AuthReset || e.PublicURL.String() != "https://j.example.com" || *e.PasswordFallback {
				t.Fatalf("%+v", e)
			}
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e, err := ParseEnv(lookup(c.env))
			if err != nil {
				t.Fatal(err)
			}
			c.check(t, e)
			// Secret values never appear in Set (only names).
			for _, n := range e.Set {
				if strings.ContainsAny(n, " @:/") {
					t.Fatalf("Set contains a value: %q", n)
				}
			}
		})
	}
}

func TestParseEnvInvalid(t *testing.T) {
	cases := map[string]map[string]string{
		"bad mode":                {"AUTH_MODE": "ldap"},
		"header without trusted":  {"AUTH_MODE": "header"},
		"bad header trusted":      {"AUTH_HEADER_TRUSTED": "10.0.0.0/99"},
		"bad header name":         {"AUTH_HEADER_NAME": "Remote User"},
		"both passwords":          {"AUTH_PASSWORD": "longenough", "AUTH_PASSWORD_HASH": "$2a$12$x"},
		"short password":          {"AUTH_PASSWORD": "short"},
		"bad hash":                {"AUTH_PASSWORD_HASH": "plaintext"},
		"bad jackett url":         {"JACKETT_URL": "jackett:9117"},
		"jackett url with creds":  {"JACKETT_URL": "http://u:p@jackett"},
		"public url with path":    {"PUBLIC_URL": "https://x.com/jackett"},
		"public url no scheme":    {"PUBLIC_URL": "x.com"},
		"bad trusted proxies":     {"TRUSTED_PROXIES": "localhost"},
		"bad ttl":                 {"SESSION_TTL": "a week"},
		"ttl too short":           {"SESSION_TTL": "1m"},
		"bad fallback":            {"AUTH_PASSWORD_FALLBACK": "maybe"},
		"bad reset":               {"AUTH_RESET": "yes please"},
		"bad log level":           {"LOG_LEVEL": "loud"},
		"bad issuer":              {"OIDC_ISSUER": "auth.example.com"},
		"github without secret":   {"GITHUB_CLIENT_ID": "x"},
		"removed oidc email list": {"OIDC_ALLOWED_EMAILS": "a@b.c"},
		"bad method":              {"AUTH_METHODS": "password,ldap"},
		"mode and methods":        {"AUTH_MODE": "password", "AUTH_METHODS": "password"},
		"mode and disabled":       {"AUTH_MODE": "none", "AUTH_DISABLED": "true"},
		"header method no trust":  {"AUTH_METHODS": "header"},
		"bad role":                {"AUTH_DEFAULT_ROLE": "root"},
		"bad disabled":            {"AUTH_DISABLED": "sure"},
		"bad auto provision":      {"AUTH_AUTO_PROVISION": "x"},
	}
	for name, env := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseEnv(lookup(env)); err == nil {
				t.Fatal("want error")
			}
		})
	}
	// All errors are reported at once.
	_, err := ParseEnv(lookup(map[string]string{"AUTH_MODE": "x", "LOG_LEVEL": "y"}))
	if err == nil || !strings.Contains(err.Error(), "AUTH_MODE") || !strings.Contains(err.Error(), "LOG_LEVEL") {
		t.Fatalf("err = %v", err)
	}
}

func mustEnv(t *testing.T, m map[string]string) *Env {
	t.Helper()
	e, err := ParseEnv(lookup(m))
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestResolveEnvWinsAndLocks(t *testing.T) {
	env := mustEnv(t, map[string]string{"AUTH_METHODS": "password,oidc", "OIDC_ISSUER": "https://idp.example", "OIDC_CLIENT_ID": "envid",
		"SESSION_TTL": "2h", "AUTH_ALLOWED_EMAILS": "a@b.c", "AUTH_DEFAULT_ROLE": "editor", "AUTH_ADMIN_EMAILS": "boss@b.c"})
	s := store.Defaults()
	s.Auth.Methods = store.Methods{Header: true}
	s.Auth.Providers.OIDC = store.Provider{Issuer: "https://stored", ClientID: "storedid", ClientSecret: "storedsecret", ProviderName: "Authentik"}
	s.Auth.AllowedEmails = []string{"stored@x"}
	s.SessionTTL = "10h"
	e, err := Resolve(env, s)
	if err != nil {
		t.Fatal(err)
	}
	p := e.Providers[ProviderOIDC]
	checks := []struct {
		name   string
		got    any
		want   any
		locked bool
		isLock bool
	}{
		{"methods", e.Methods.Value, store.Methods{Password: true, OIDC: true}, e.Methods.Locked, true},
		{"disabled", e.Disabled.Value, false, e.Disabled.Locked, false},
		{"issuer", p.Issuer.Value, "https://idp.example", p.Issuer.Locked, true},
		{"client id", p.ClientID.Value, "envid", p.ClientID.Locked, true},
		{"secret from file", p.ClientSecret.Value, "storedsecret", p.ClientSecret.Locked, false},
		{"name from file", p.Name.Value, "Authentik", p.Name.Locked, false},
		{"scopes default", p.Scopes.Value, DefaultScopes, p.Scopes.Locked, false},
		{"ttl", e.SessionTTL.Value, 2 * time.Hour, e.SessionTTL.Locked, true},
		{"role", e.DefaultRole.Value, "editor", e.DefaultRole.Locked, true},
		{"auto-provision from file", e.AutoProvision.Value, true, e.AutoProvision.Locked, false},
		{"header name default", e.HeaderName.Value, DefaultHeaderName, e.HeaderName.Locked, false},
	}
	for _, c := range checks {
		if c.got != c.want || c.locked != c.isLock {
			t.Errorf("%s: got %v (locked %v), want %v (locked %v)", c.name, c.got, c.locked, c.want, c.isLock)
		}
	}
	if !slices.Equal(e.AllowedEmails.Value, []string{"a@b.c"}) || !e.AllowedEmails.Locked || e.AllowedEmails.Env != "AUTH_ALLOWED_EMAILS" {
		t.Fatalf("allowed emails: %+v", e.AllowedEmails)
	}
	if !slices.Equal(e.AdminEmails.Value, []string{"boss@b.c"}) || !e.AdminEmails.Locked {
		t.Fatalf("admin emails: %+v", e.AdminEmails)
	}
	if e.Providers[ProviderGoogle].Issuer.Value != GoogleIssuer {
		t.Fatal("google issuer not fixed")
	}
}

func TestDeprecatedAuthModeMapping(t *testing.T) {
	cases := []struct {
		env      map[string]string
		methods  store.Methods
		disabled bool
	}{
		{map[string]string{"AUTH_MODE": "password"}, store.Methods{Password: true}, false},
		{map[string]string{"AUTH_MODE": "none"}, store.Methods{Password: true}, true},
		{map[string]string{"AUTH_MODE": "header", "AUTH_HEADER_TRUSTED": "10.0.0.0/8"}, store.Methods{Header: true}, false},
		{map[string]string{"AUTH_MODE": "oidc", "GOOGLE_CLIENT_ID": "g", "GITHUB_CLIENT_ID": "x", "GITHUB_CLIENT_SECRET": "y"},
			store.Methods{Password: true, Google: true, GitHub: true}, false},
		{map[string]string{"AUTH_MODE": "sso", "AUTH_PASSWORD_FALLBACK": "false", "OIDC_ISSUER": "https://i", "OIDC_CLIENT_ID": "c"},
			store.Methods{OIDC: true}, false},
	}
	for _, c := range cases {
		e, err := Resolve(mustEnv(t, c.env), store.Defaults())
		if err != nil {
			t.Fatal(err)
		}
		if e.Methods.Value != c.methods || !e.Methods.Locked || e.Methods.Env != "AUTH_MODE" || e.Disabled.Value != c.disabled || !e.Disabled.Locked {
			t.Errorf("%v: methods %+v disabled %+v", c.env, e.Methods, e.Disabled)
		}
	}
}

func TestSetupRequiredAndLoginMethods(t *testing.T) {
	cases := []struct {
		name               string
		env                map[string]string
		users              int
		methods            store.Methods
		disabled           bool
		setup, pw, headerL bool
	}{
		{"fresh install", nil, 0, store.Methods{Password: true}, false, true, true, false},
		{"one user", nil, 1, store.Methods{Password: true}, false, false, true, false},
		{"disabled", nil, 0, store.Methods{Password: true}, true, false, false, false},
		{"sso only", nil, 1, store.Methods{OIDC: true}, false, false, false, false},
		{"header without trusted", nil, 1, store.Methods{Header: true}, false, false, false, false},
		{"header", map[string]string{"AUTH_HEADER_TRUSTED": "10.0.0.0/8"}, 1, store.Methods{Header: true}, false, false, false, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := store.Defaults()
			s.Auth.Methods, s.Auth.Disabled = c.methods, c.disabled
			for range c.users {
				s.Users = append(s.Users, store.User{ID: store.NewID("u_")})
			}
			e, err := Resolve(mustEnv(t, c.env), s)
			if err != nil {
				t.Fatal(err)
			}
			if e.SetupRequired() != c.setup || e.PasswordLogin() != c.pw || e.HeaderLogin() != c.headerL {
				t.Fatalf("setup=%v pw=%v header=%v", e.SetupRequired(), e.PasswordLogin(), e.HeaderLogin())
			}
		})
	}
}

func TestProviderVerifiedAndAllowLists(t *testing.T) {
	env := mustEnv(t, nil)
	s := store.Defaults()
	s.Auth.Methods = store.Methods{OIDC: true, Google: true}
	s.Auth.Providers.OIDC = store.Provider{Issuer: "https://idp", ClientID: "c", ClientSecret: "s"}
	s.Auth.Providers.Google = store.Provider{ClientID: "g"}
	e, _ := Resolve(env, s)
	if len(e.EnabledProviders()) != 2 {
		t.Fatalf("enabled = %d", len(e.EnabledProviders()))
	}
	if e.Providers["oidc"].Verified() || len(e.LoginProviders()) != 0 || e.ProviderReady("oidc") {
		t.Fatal("unverified provider offered")
	}
	// Verify oidc.
	s.Auth.Providers.OIDC.VerifiedHash = e.Providers["oidc"].Hash()
	e, _ = Resolve(env, s)
	if !e.Providers["oidc"].Verified() || !e.ProviderReady("oidc") {
		t.Fatal("hash match not verified")
	}
	// v0.3: linked identities log in without allow-lists, so the button shows.
	if lp := e.LoginProviders(); len(lp) != 1 || lp[0].ID != "oidc" || e.AllowListSet() {
		t.Fatalf("login providers = %+v", lp)
	}
	// Method off: not offered, still ready for linking.
	s.Auth.Methods.OIDC = false
	e, _ = Resolve(env, s)
	if len(e.LoginProviders()) != 0 || !e.ProviderReady("oidc") {
		t.Fatal("method switch ignored")
	}
	s.Auth.Methods.OIDC = true
	// Fields that reset verified: client id, secret, issuer, scopes.
	for name, mut := range map[string]func(p *store.Provider){
		"clientId": func(p *store.Provider) { p.ClientID = "c2" },
		"secret":   func(p *store.Provider) { p.ClientSecret = "s2" },
		"issuer":   func(p *store.Provider) { p.Issuer = "https://idp2" },
		"scopes":   func(p *store.Provider) { p.Scopes = "openid email" },
	} {
		s2 := s.Clone()
		mut(&s2.Auth.Providers.OIDC)
		e2, _ := Resolve(env, s2)
		if e2.Providers["oidc"].Verified() {
			t.Errorf("%s change kept verified", name)
		}
	}
	// Other fields keep it.
	s2 := s.Clone()
	s2.Auth.Providers.OIDC.ProviderName = "New name"
	s2.Auth.Providers.OIDC.AllowedGroups = []string{"x"}
	if e2, _ := Resolve(env, s2); !e2.Providers["oidc"].Verified() {
		t.Error("name/groups change reset verified")
	}
	// GitHub users alone admit only github; admin e-mails admit everyone.
	s3 := store.Defaults()
	s3.Auth.GitHubUsers = []string{"octo"}
	e3, _ := Resolve(env, s3)
	if e3.ProviderCanAllow("google") || e3.ProviderCanAllow("oidc") || !e3.ProviderCanAllow("github") {
		t.Fatal("ProviderCanAllow wrong for github users")
	}
	s3.Auth.AdminEmails = []string{"boss@x"}
	if e3, _ = Resolve(env, s3); !e3.ProviderCanAllow("google") {
		t.Fatal("admin e-mails do not admit")
	}
}

func TestProviderFromEnvCountsAsVerified(t *testing.T) {
	env := mustEnv(t, map[string]string{"GOOGLE_CLIENT_ID": "g", "GOOGLE_CLIENT_SECRET": "s", "OIDC_CLIENT_ID": "o"})
	s := store.Defaults()
	s.Auth.Providers.OIDC.Issuer = "https://stored-issuer"
	e, _ := Resolve(env, s)
	if !e.Providers["google"].Verified() {
		t.Fatal("env-only google not verified")
	}
	if e.Providers["oidc"].Verified() {
		t.Fatal("oidc with stored issuer counted as env-configured")
	}
}

func TestValidate(t *testing.T) {
	cases := []struct {
		name    string
		env     map[string]string
		methods store.Methods
		ok      bool
	}{
		{"password", nil, store.Methods{Password: true}, true},
		{"env oidc without provider", map[string]string{"AUTH_METHODS": "oidc"}, store.Methods{}, false},
		{"legacy sso without provider is password-only", map[string]string{"AUTH_MODE": "sso"}, store.Methods{}, true},
		{"env google", map[string]string{"AUTH_METHODS": "google", "GOOGLE_CLIENT_ID": "g"}, store.Methods{}, true},
		{"stored header without trusted", nil, store.Methods{Header: true}, false},
		{"stored oidc without provider (just not offered)", nil, store.Methods{OIDC: true}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := store.Defaults()
			s.Auth.Methods = c.methods
			e, err := Resolve(mustEnv(t, c.env), s)
			if err != nil {
				t.Fatal(err)
			}
			if (e.Validate() == nil) != c.ok {
				t.Fatalf("Validate = %v", e.Validate())
			}
		})
	}
	s := store.Defaults()
	s.Auth.AutoProvision.Role = "root"
	if _, err := Resolve(mustEnv(t, nil), s); err == nil {
		t.Fatal("unknown stored role accepted")
	}
}

func TestSessionTTLString(t *testing.T) {
	for d, want := range map[time.Duration]string{168 * time.Hour: "168h", 30 * time.Minute: "30m", 90 * time.Minute: "1h30m"} {
		if got := SessionTTLString(d); got != want {
			t.Errorf("%v → %q, want %q", d, got, want)
		}
	}
}
