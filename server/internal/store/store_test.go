package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	fb := false
	err := st.Update(func(s *Settings) error {
		s.AuthEpoch = 7
		s.Auth.Mode = "sso"
		s.Auth.PasswordHash = "$2a$12$abc"
		s.Auth.PasswordFallback = &fb
		s.Auth.AllowedEmails = []string{"a@b.c"}
		s.Auth.GitHubUsers = []string{"octo"}
		s.Auth.Providers.OIDC = Provider{Issuer: "https://idp", ClientID: "cid", ClientSecret: "sec", AllowedGroups: []string{"g"}, VerifiedHash: "h"}
		s.Auth.Providers.GitHub.ClientID = "gh"
		s.Auth.Header = Header{Name: "Remote-User", Trusted: []string{"10.0.0.0/8"}}
		s.PublicURL = "https://x"
		s.SessionTTL = "24h"
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
	if *b.Auth.PasswordFallback != false || b.Auth.Providers.OIDC.ClientSecret != "sec" {
		t.Fatalf("lost values: %+v", b.Auth)
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
	if err := os.WriteFile(p, []byte(`{"version":1,"authEpoch":2}`), 0o644); err != nil {
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
