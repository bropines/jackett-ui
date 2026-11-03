package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/bropines/jackett-ui/server/internal/store"
)

func TestAuthReset(t *testing.T) {
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_ = st.Update(func(s *store.Settings) error {
		s.AuthEpoch = 5
		s.Auth.Mode = "sso"
		s.Auth.PasswordHash = "$2a$12$x"
		s.Auth.AllowedEmails = []string{"a@b.c"}
		s.Auth.Providers.OIDC = store.Provider{Issuer: "https://idp", ClientID: "c", ClientSecret: "s", VerifiedHash: "h"}
		s.Auth.Header.Name = "X-User"
		s.PublicURL = "https://keep.me"
		return nil
	})
	oldKey := string(st.Get().SessionKey)
	if err := authReset(st); err != nil {
		t.Fatal(err)
	}
	s := st.Get()
	if s.Auth.Mode != "" || s.Auth.PasswordHash != "" || s.Auth.Providers.OIDC.ClientID != "" || s.Auth.Providers.OIDC.VerifiedHash != "" || len(s.Auth.AllowedEmails) != 0 {
		t.Fatalf("auth not reset: %+v", s.Auth)
	}
	if string(s.SessionKey) == oldKey || s.AuthEpoch != 6 {
		t.Fatal("session key not rotated / epoch not bumped")
	}
	if s.PublicURL != "https://keep.me" || s.Auth.Header.Name != "X-User" {
		t.Fatal("non-auth settings lost")
	}
}

func TestStaticFS(t *testing.T) {
	// Placeholder (no dist/ embedded in tests).
	fsys, src, err := staticFS("")
	if err != nil {
		t.Fatal(err)
	}
	if src != "placeholder" && src != "embedded" {
		t.Fatalf("src %q", src)
	}
	if b, err := fs.ReadFile(fsys, "index.html"); err != nil || len(b) == 0 {
		t.Fatalf("index: %v", err)
	}
	if src == "placeholder" {
		if _, err := fsys.Open("embed.go"); err == nil {
			t.Fatal("placeholder FS exposes other files")
		}
	}
	// STATIC_DIR.
	dir := t.TempDir()
	if _, _, err := staticFS(dir); err == nil {
		t.Fatal("dir without index.html accepted")
	}
	_ = os.WriteFile(filepath.Join(dir, "index.html"), []byte("x"), 0o644)
	if _, src, err := staticFS(dir); err != nil || src != dir {
		t.Fatalf("%v %s", err, src)
	}
}
