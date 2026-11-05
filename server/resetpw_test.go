package main

import (
	"bytes"
	"testing"

	"github.com/bropines/jackett-ui/server/internal/store"
	"github.com/bropines/jackett-ui/server/internal/users"
)

func TestResetPasswordOpensWizard(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	_ = st.Update(func(s *store.Settings) error {
		s.Users = []store.User{
			{ID: "u_a", Username: "admin", Role: store.RoleAdmin, Bootstrap: true, Epoch: 1},
			{ID: "u_v", Username: "vv", Role: store.RoleViewer, Epoch: 1},
		}
		return nil
	})
	env := map[string]string{"DATA_DIR": dir, "JACKETT_URL": "http://127.0.0.1:9117"}
	lookup := func(k string) (string, bool) { v, ok := env[k]; return v, ok }
	pw := func() (string, error) { return "brand-new-pass", nil }
	run := func(args ...string) store.Settings {
		t.Helper()
		var out bytes.Buffer
		if err := resetPassword(args, lookup, pw, &out); err != nil {
			t.Fatal(err)
		}
		s, err := store.Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		return s.Get()
	}
	s := run("admin")
	if a := users.ByUsername(&s, "admin"); !a.Onboard || a.Bootstrap || !s.Onboarded {
		t.Fatalf("admin: %+v onboarded=%v", a, s.Onboarded)
	}
	s = run("admin", "--no-wizard")
	if users.ByUsername(&s, "admin").Onboard {
		t.Fatal("--no-wizard")
	}
	s = run("vv")
	if users.ByUsername(&s, "vv").Onboard {
		t.Fatal("viewer flagged")
	}
}
