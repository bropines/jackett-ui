package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOpenCreatesFileWithKeyAnd0600(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(dir, FileName))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("perm = %v, want 0600", fi.Mode().Perm())
	}
	s := st.Get()
	if s.Version != CurrentVersion || len(s.SessionKey) != SessionKeySize {
		t.Fatalf("bad initial settings: %+v", s)
	}
	// Reopen: same key.
	st2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if string(st2.Get().SessionKey) != string(s.SessionKey) {
		t.Fatal("session key changed on reopen")
	}
}

func TestRoundTrip(t *testing.T) {
	dir := t.TempDir()
	st, _ := Open(dir)
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	err := st.Update(func(s *Settings) error {
		s.AuthEpoch = 7
		s.Auth.Methods = Methods{Password: true, OIDC: true}
		s.Auth.Disabled = false
		s.Auth.AutoProvision = AutoProvision{Enabled: true, Role: RoleEditor}
		s.Auth.AllowedEmails = []string{"a@b.c"}
		s.Auth.AdminEmails = []string{"boss@b.c"}
		s.Auth.GitHubUsers = []string{"octo"}
		s.Auth.Providers.OIDC = Provider{Issuer: "https://idp", ClientID: "cid", ClientSecret: "sec", AllowedGroups: []string{"g"}, VerifiedHash: "h"}
		s.Auth.Providers.GitHub.ClientID = "gh"
		s.Auth.Header = Header{Name: "Remote-User", Trusted: []string{"10.0.0.0/8"}}
		s.PublicURL = "https://x"
		s.SessionTTL = "24h"
		s.Users = []User{{ID: "u_1", Username: "admin", Role: RoleAdmin, PasswordHash: "$2a$12$abc", Epoch: 3, CreatedAt: now, LastLoginAt: &now,
			Identities: []Identity{{Provider: "oidc", Issuer: "https://idp", Subject: "s1", Label: "a@b.c", LinkedAt: now}}}}
		s.Tokens = []Token{{ID: "t_1", UserID: "u_1", Name: "qb", Prefix: "jui_abcd", Hash: "ff", CreatedAt: now, ExpiresAt: &now}}
		s.Invites = []Invite{{ID: "i_1", Hash: "ee", Role: RoleViewer, Name: "x", CreatedBy: "u_1", CreatedAt: now, ExpiresAt: now}}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	st2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	a, b := st.Get(), st2.Get()
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	if string(ja) != string(jb) {
		t.Fatalf("round trip mismatch:\n%s\n%s", ja, jb)
	}
	if b.Users[0].Identities[0].Subject != "s1" || b.Auth.Providers.OIDC.ClientSecret != "sec" || b.Tokens[0].ExpiresAt == nil {
		t.Fatalf("lost values: %+v", b)
	}
	// Deep copy of users, identities and tokens.
	c := st2.Get()
	c.Users[0].Identities[0].Subject = "mutated"
	*c.Tokens[0].ExpiresAt = time.Time{}
	*c.Users[0].LastLoginAt = time.Time{}
	if d := st2.Get(); d.Users[0].Identities[0].Subject != "s1" || d.Tokens[0].ExpiresAt.IsZero() || d.Users[0].LastLoginAt.IsZero() {
		t.Fatal("Get shares user/token memory")
	}
}

func TestUpdateErrorWritesNothing(t *testing.T) {
	dir := t.TempDir()
	st, _ := Open(dir)
	before, _ := os.ReadFile(st.Path())
	boom := errors.New("boom")
	if err := st.Update(func(s *Settings) error { s.AuthEpoch = 99; return boom }); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
	after, _ := os.ReadFile(st.Path())
	if string(before) != string(after) || st.Get().AuthEpoch == 99 {
		t.Fatal("failed update changed state")
	}
}

func TestGetReturnsDeepCopy(t *testing.T) {
	st, _ := Open(t.TempDir())
	_ = st.Update(func(s *Settings) error { s.Auth.AllowedEmails = []string{"a"}; return nil })
	c := st.Get()
	c.Auth.AllowedEmails[0] = "mutated"
	c.SessionKey[0] ^= 0xff
	if st.Get().Auth.AllowedEmails[0] != "a" {
		t.Fatal("Get leaked a shared slice")
	}
}

func TestAtomicWriteLeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	st, _ := Open(dir)
	for i := 0; i < 5; i++ {
		_ = st.Update(func(s *Settings) error { s.AuthEpoch++; return nil })
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != FileName {
			t.Fatalf("leftover file %s", e.Name())
		}
	}
	fi, _ := os.Stat(st.Path())
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("perm after update = %v", fi.Mode().Perm())
	}
}

func TestOpenTightensPermissions(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, FileName)
	if err := os.WriteFile(p, []byte(`{"version":2,"authEpoch":2}`), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(p)
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("perm = %v", fi.Mode().Perm())
	}
	if st.Get().AuthEpoch != 2 || len(st.Get().SessionKey) != SessionKeySize {
		t.Fatal("existing values lost or key not generated")
	}
}

func TestOpenErrors(t *testing.T) {
	cases := map[string]string{
		"garbage":     `{not json`,
		"new version": `{"version":99}`,
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			_ = os.WriteFile(filepath.Join(dir, FileName), []byte(content), 0o600)
			if _, err := Open(dir); err == nil {
				t.Fatal("want error")
			}
		})
	}
	if _, err := Open(""); err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatal("want error for empty dir")
	}
}

func TestMigrateV2(t *testing.T) {
	dir := t.TempDir()
	orig := `{"version":2,"sessionKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","authEpoch":3,"auth":{"methods":{"password":true,"oidc":true}},"users":[{"id":"u_1","username":"admin","role":"admin","epoch":1}]}`
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte(orig), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	s := st.Get()
	if st.Migrated != 2 || s.Version != CurrentVersion || s.Auth.Methods != (Methods{Password: true, OIDC: true, Passkey: true}) || len(s.Users) != 1 || s.AuthEpoch != 3 || s.Onboarded {
		t.Fatalf("migrated: %d %+v", st.Migrated, s)
	}
	if bak, err := os.ReadFile(filepath.Join(dir, BackupV2Name)); err != nil || string(bak) != orig {
		t.Fatalf("backup: %v", err)
	}
	if st2, err := Open(dir); err != nil || st2.Migrated != 0 {
		t.Fatalf("reopen: %v", err)
	}
}

func TestReloadOnExternalChange(t *testing.T) {
	dir := t.TempDir()
	a, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	// Another process (the reset-password command) writes the file.
	b, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Update(func(s *Settings) error { s.PublicURL = "https://other"; return nil }); err != nil {
		t.Fatal(err)
	}
	// An Update in the first process must not overwrite it.
	if err := a.Update(func(s *Settings) error { s.SessionTTL = "1h"; return nil }); err != nil {
		t.Fatal(err)
	}
	if s := a.Get(); s.PublicURL != "https://other" || s.SessionTTL != "1h" {
		t.Fatalf("update over external change: %+v", s)
	}
	// Get notices outside changes too (after the check interval).
	if err := b.Update(func(s *Settings) error { s.PublicURL = "https://third-one"; return nil }); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	a.checked = time.Time{}
	a.mu.Unlock()
	if s := a.Get(); s.PublicURL != "https://third-one" {
		t.Fatalf("get after external change: %q", s.PublicURL)
	}
	// Garbage in the file is ignored.
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	a.checked = time.Time{}
	a.mu.Unlock()
	if s := a.Get(); s.PublicURL != "https://third-one" {
		t.Fatal("broken file replaced the settings")
	}
}
