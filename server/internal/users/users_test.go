package users

import (
	"strings"
	"testing"
	"time"

	"github.com/bropines/jackett-ui/server/internal/store"
)

func TestValidUsername(t *testing.T) {
	for s, ok := range map[string]bool{
		"admin": true, "a.b_c-1": true, "ab": true, strings.Repeat("a", 32): true,
		"a": false, strings.Repeat("a", 33): false, "Admin": false, "a b": false, "a@b": false, "": false, "юзер": false,
	} {
		if ValidUsername(s) != ok {
			t.Errorf("%q: %v", s, !ok)
		}
	}
}

func TestDeriveUsername(t *testing.T) {
	taken := map[string]bool{"alice": true, "alice-2": true, "user": true}
	f := func(n string) bool { return taken[n] }
	cases := map[string]string{
		"Alice@Example.com":      "alice-3",
		"bob.smith@example.com":  "bob.smith",
		"Octo-Cat":               "octo-cat",
		"x":                      "user-2",
		"Иван Петров":            "user-2",
		"weird name+tag@x":       "weird-name-tag",
		strings.Repeat("z", 40):  strings.Repeat("z", 32),
		"  .-leading.trailing-.": "leading.trailing",
	}
	for in, want := range cases {
		if got := DeriveUsername(in, f); got != want || !ValidUsername(got) {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
	}
	long := strings.Repeat("q", 32)
	taken[long] = true
	if got := DeriveUsername(long, f); got != strings.Repeat("q", 30)+"-2" {
		t.Errorf("long dedupe: %q", got)
	}
}

func TestTokens(t *testing.T) {
	tok, prefix, hash := NewToken()
	if len(tok) != 36 || !strings.HasPrefix(tok, "jui_") || prefix != tok[:8] || hash != HashSecret(tok) || len(hash) != 64 || !LooksLikeToken(tok) {
		t.Fatalf("token %q prefix %q hash %q", tok, prefix, hash)
	}
	tok2, _, _ := NewToken()
	if tok == tok2 {
		t.Fatal("tokens repeat")
	}
	s := &store.Settings{Tokens: []store.Token{{ID: "t_a", Hash: HashSecret(tok2)}, {ID: "t_b", Hash: hash}}}
	if got := FindToken(s, tok); got == nil || got.ID != "t_b" {
		t.Fatalf("FindToken: %+v", got)
	}
	for _, bad := range []string{"", "jui_", tok[:35], tok + "x", "JUI_" + tok[4:], "jui_" + strings.Repeat("!", 32), hash} {
		if FindToken(s, bad) != nil {
			t.Errorf("found %q", bad)
		}
	}
	sec, h := NewInviteSecret()
	s.Invites = []store.Invite{{ID: "i_1", Hash: h, ExpiresAt: time.Now().Add(time.Hour)}, {ID: "i_2", Hash: "x", ExpiresAt: time.Now().Add(-time.Hour)}}
	if inv := FindInvite(s, sec); inv == nil || inv.ID != "i_1" || FindInvite(s, sec+"x") != nil || FindInvite(s, "short") != nil {
		t.Fatal("FindInvite")
	}
	PruneInvites(s, time.Now())
	if len(s.Invites) != 1 || s.Invites[0].ID != "i_1" {
		t.Fatalf("prune: %+v", s.Invites)
	}
}

func TestLookups(t *testing.T) {
	s := &store.Settings{Users: []store.User{
		{ID: "u_1", Username: "admin", Role: store.RoleAdmin},
		{ID: "u_2", Username: "bob", Role: store.RoleAdmin, Disabled: true, Identities: []store.Identity{{Provider: "oidc", Issuer: "i", Subject: "s"}}},
		{ID: "u_3", Username: "eve", Role: store.RoleViewer},
	}, Tokens: []store.Token{{UserID: "u_2"}, {UserID: "u_3"}, {UserID: "u_2"}}}
	if ByUsername(s, " ADMIN ").ID != "u_1" || ByUsername(s, "nobody") != nil {
		t.Fatal("ByUsername")
	}
	if ByIdentity(s, "oidc", "i", "s").ID != "u_2" || ByIdentity(s, "oidc", "other", "s") != nil || ByIdentity(s, "google", "i", "s") != nil {
		t.Fatal("ByIdentity")
	}
	if EnabledAdmins(s) != 1 || TokenCount(s, "u_2") != 2 {
		t.Fatal("counts")
	}
	DeleteTokensOf(s, "u_2")
	if len(s.Tokens) != 1 || s.Tokens[0].UserID != "u_3" {
		t.Fatal("DeleteTokensOf")
	}
	if !ValidName("Иван Петров") || ValidName("a\nb") || ValidName(strings.Repeat("я", 65)) {
		t.Fatal("ValidName")
	}
}
