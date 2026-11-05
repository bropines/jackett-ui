package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeV1(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

const v1Key = `"sessionKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="`

func TestMigrateV1Modes(t *testing.T) {
	providers := `"providers":{"oidc":{"issuer":"https://idp","clientId":"oc","clientSecret":"os","verifiedHash":"vh"},"google":{"clientId":"","clientSecret":""},"github":{"clientId":"gh","clientSecret":"ghs"}}`
	cases := []struct {
		name     string
		auth     string
		methods  Methods
		disabled bool
		role     string
		admin    bool
	}{
		{"password", `"mode":"password","passwordHash":"$2a$12$hash"`, Methods{Password: true, Passkey: true}, false, RoleViewer, true},
		{"never configured", `"mode":""`, Methods{Password: true, Passkey: true}, false, RoleViewer, false},
		{"sso with fallback", `"mode":"sso","passwordHash":"$2a$12$hash",` + providers, Methods{Password: true, OIDC: true, GitHub: true, Passkey: true}, false, RoleAdmin, true},
		{"sso without fallback", `"mode":"sso","passwordFallback":false,` + providers, Methods{OIDC: true, GitHub: true, Passkey: true}, false, RoleAdmin, false},
		{"legacy oidc (no password: fallback off)", `"mode":"oidc",` + providers, Methods{OIDC: true, GitHub: true, Passkey: true}, false, RoleAdmin, false},
		{"header", `"mode":"header","header":{"name":"X-User","trusted":["10.0.0.0/8"]}`, Methods{Header: true, Passkey: true}, false, RoleAdmin, false},
		{"none", `"mode":"none","passwordHash":"$2a$12$hash"`, Methods{Password: true, Passkey: true}, true, RoleViewer, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			orig := `{"version":1,` + v1Key + `,"authEpoch":4,"publicUrl":"https://j.example","sessionTtl":"24h","auth":{` + c.auth + `,"allowedEmails":["a@b.c"],"githubUsers":["octo"]}}`
			dir := writeV1(t, orig)
			st, err := Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			if st.Migrated != 1 {
				t.Fatalf("Migrated = %d", st.Migrated)
			}
			s := st.Get()
			if s.Version != CurrentVersion || s.Auth.Methods != c.methods || s.Auth.Disabled != c.disabled || s.Auth.AutoProvision.Role != c.role || !s.Auth.AutoProvision.Enabled {
				t.Fatalf("auth: %+v", s.Auth)
			}
			if s.AuthEpoch != 5 || s.PublicURL != "https://j.example" || s.SessionTTL != "24h" || len(s.SessionKey) != SessionKeySize {
				t.Fatalf("misc: epoch=%d %q %q", s.AuthEpoch, s.PublicURL, s.SessionTTL)
			}
			if s.Auth.AllowedEmails[0] != "a@b.c" || s.Auth.GitHubUsers[0] != "octo" {
				t.Fatal("allow-lists lost")
			}
			if strings.Contains(c.auth, "providers") && (s.Auth.Providers.OIDC.VerifiedHash != "vh" || s.Auth.Providers.GitHub.ClientSecret != "ghs") {
				t.Fatal("providers lost")
			}
			if c.admin {
				if len(s.Users) != 1 || s.Users[0].Username != "admin" || s.Users[0].Role != RoleAdmin || s.Users[0].PasswordHash != "$2a$12$hash" ||
					!strings.HasPrefix(s.Users[0].ID, "u_") || len(s.Users[0].ID) != 18 || s.Users[0].Epoch == 0 {
					t.Fatalf("users: %+v", s.Users)
				}
			} else if len(s.Users) != 0 {
				t.Fatalf("unexpected users: %+v", s.Users)
			}
			// Backup has the original bytes; the new file has no v1 fields.
			bak, err := os.ReadFile(filepath.Join(dir, BackupV1Name))
			if err != nil || string(bak) != orig {
				t.Fatalf("backup: %v %q", err, bak)
			}
			if fi, _ := os.Stat(filepath.Join(dir, BackupV1Name)); fi.Mode().Perm() != 0o600 {
				t.Fatal("backup not 0600")
			}
			raw, _ := os.ReadFile(st.Path())
			if strings.Contains(string(raw), `"mode"`) || strings.Contains(string(raw), "passwordFallback") || !strings.Contains(string(raw), `"version": 3`) {
				t.Fatalf("new file: %s", raw)
			}
			// Reopen: no second migration.
			st2, err := Open(dir)
			if err != nil || st2.Migrated != 0 || st2.Get().AuthEpoch != 5 {
				t.Fatalf("reopen: %v %d", err, st2.Migrated)
			}
		})
	}
}

func TestMigrateVersionZeroAndFreshDefaults(t *testing.T) {
	dir := writeV1(t, `{"authEpoch":1}`)
	st, err := Open(dir)
	if err != nil || st.Migrated != 1 || st.Get().Auth.Methods != (Methods{Password: true, Passkey: true}) {
		t.Fatalf("v0: %v %+v", err, st.Get().Auth)
	}
	fresh, _ := Open(t.TempDir())
	s := fresh.Get()
	if fresh.Migrated != 0 || s.Auth.Methods != (Methods{Password: true, Passkey: true}) || !s.Auth.AutoProvision.Enabled || s.Auth.AutoProvision.Role != RoleViewer || len(s.Users) != 0 {
		t.Fatalf("fresh: %+v", s.Auth)
	}
}

func TestNewID(t *testing.T) {
	seen := map[string]bool{}
	for range 100 {
		id := NewID("t_")
		if len(id) != 18 || !strings.HasPrefix(id, "t_") || seen[id] || strings.ToLower(id) != id {
			t.Fatalf("bad id %q", id)
		}
		seen[id] = true
	}
}
