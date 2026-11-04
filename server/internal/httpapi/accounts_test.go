package httpapi

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bropines/jackett-ui/server/internal/auth"
	"github.com/bropines/jackett-ui/server/internal/session"
	"github.com/bropines/jackett-ui/server/internal/store"
)

func TestSetupWithUsernameAndLogin(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	if w := h.do("POST", "/_ui/api/auth/setup", map[string]string{"username": "Bad Name", "password": adminPW}); w.Code != 400 || errorCode(w) != "invalid_username" {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	h.expect(h.do("POST", "/_ui/api/auth/setup", map[string]string{"username": "Root", "password": adminPW}), 204)
	if st := h.state(); st.User == nil || st.User.Username != "root" || st.User.Role != "admin" {
		t.Fatalf("%+v", st.User)
	}
	c := h.clone()
	// Unknown user and wrong password look the same.
	for _, cred := range [][2]string{{"nobody", adminPW}, {"root", "wrong-password"}, {"", adminPW} /* default "admin" */} {
		if w := c.loginAs(cred[0], cred[1]); w.Code != 401 || errorCode(w) != "invalid_credentials" {
			t.Fatalf("%v: %d", cred, w.Code)
		}
	}
	c.expect(c.loginAs(" ROOT ", adminPW), 204)
	if u := h.userByName("root"); u.LastLoginAt == nil {
		t.Fatal("lastLoginAt not set")
	}
	// Disabled user with the right password.
	h.createUser("bob", "viewer", "bob-password")
	bob := h.as("bob", "bob-password")
	h.expect(h.do("PATCH", "/_ui/api/users/"+h.userByName("bob").ID, map[string]any{"disabled": true}), 200)
	bob.expect(bob.do("GET", "/_ui/api/me", nil), 401)
	if w := h.clone().loginAs("bob", "bob-password"); w.Code != 401 || errorCode(w) != "user_disabled" {
		t.Fatalf("disabled: %d %s", w.Code, w.Body)
	}
}

func TestUsersAdmin(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	adminID := h.userByName("admin").ID
	id := h.createUser("ed", "editor", "editor-password")

	for _, c := range []struct {
		body map[string]any
		code int
		err  string
	}{
		{map[string]any{"username": "ed", "role": "viewer"}, 409, "username_taken"},
		{map[string]any{"username": "ED", "role": "viewer"}, 409, "username_taken"},
		{map[string]any{"username": "x", "role": "viewer"}, 400, "invalid_username"},
		{map[string]any{"username": "ok-name", "role": "root"}, 400, "invalid_value"},
		{map[string]any{"username": "ok-name", "role": "viewer", "password": "short"}, 400, "password_too_short"},
		{map[string]any{"username": "ok-name", "role": "viewer", "name": "a\x01"}, 400, "invalid_value"},
	} {
		if w := h.do("POST", "/_ui/api/users", c.body); w.Code != c.code || errorCode(w) != c.err {
			t.Fatalf("%v: %d %s", c.body, w.Code, w.Body)
		}
	}
	list := decode[[]userView](t, h.do("GET", "/_ui/api/users", nil))
	if len(list) != 2 || list[1].Username != "ed" || list[1].Name != "ED" || list[1].Role != "editor" || !list[1].PasswordSet || list[1].Identities == nil {
		t.Fatalf("list: %+v", list)
	}
	raw := h.do("GET", "/_ui/api/users", nil).Body.String()
	if strings.Contains(raw, "$2a$") || strings.Contains(raw, "passwordHash") {
		t.Fatal("users list leaks hashes")
	}

	// Role change ends the user's sessions (epoch); reset password too.
	ed := h.as("ed", "editor-password")
	epoch := h.userByName("ed").Epoch
	w := h.do("PATCH", "/_ui/api/users/"+id, map[string]any{"role": "viewer", "name": "Eddie"})
	h.expect(w, 200)
	if v := decode[userView](t, w); v.Role != "viewer" || v.Name != "Eddie" || h.userByName("ed").Epoch != epoch+1 {
		t.Fatalf("patch: %+v", v)
	}
	ed.expect(ed.do("GET", "/_ui/api/me", nil), 401)
	// Name-only change keeps sessions.
	ed = h.as("ed", "editor-password")
	h.expect(h.do("PATCH", "/_ui/api/users/"+id, map[string]any{"name": "Ed"}), 200)
	ed.expect(ed.do("GET", "/_ui/api/me", nil), 200)
	h.expect(h.do("PATCH", "/_ui/api/users/"+id, map[string]any{"password": "reset-password"}), 200)
	ed.expect(ed.do("GET", "/_ui/api/me", nil), 401)
	h.clone().expect(h.clone().loginAs("ed", "reset-password"), 204)
	// Log a user out.
	ed = h.as("ed", "reset-password")
	h.expect(h.do("POST", "/_ui/api/users/"+id+"/logout", nil, xhr), 204)
	ed.expect(ed.do("GET", "/_ui/api/me", nil), 401)
	h.expect(h.do("PATCH", "/_ui/api/users/u_nope", map[string]any{"name": "x"}), 404)

	// Last enabled admin: no demote, disable or delete.
	for _, patch := range []map[string]any{{"role": "editor"}, {"disabled": true}} {
		if w := h.do("PATCH", "/_ui/api/users/"+adminID, patch); w.Code != 409 || errorCode(w) != "last_admin" {
			t.Fatalf("%v: %d", patch, w.Code)
		}
	}
	if w := h.do("DELETE", "/_ui/api/users/"+adminID, nil, xhr); w.Code != 409 || errorCode(w) != "last_admin" {
		t.Fatalf("delete last admin: %d", w.Code)
	}
	// With a second admin, the first can step down (own session re-issued).
	h.expect(h.do("PATCH", "/_ui/api/users/"+id, map[string]any{"role": "admin"}), 200)
	h.expect(h.do("PATCH", "/_ui/api/users/"+adminID, map[string]any{"role": "viewer"}), 200)
	if st := h.state(); st.User == nil || st.User.Role != "viewer" {
		t.Fatalf("self demote: %+v", st)
	}
	h.expect(h.do("GET", "/_ui/api/users", nil), 403)
	ed = h.as("ed", "reset-password")
	if w := ed.do("PATCH", "/_ui/api/users/"+id, map[string]any{"disabled": true}); w.Code != 409 || errorCode(w) != "last_admin" {
		t.Fatalf("self disable as last admin: %d", w.Code)
	}
	// Delete a user (self-delete clears the cookie).
	ed.expect(ed.do("PATCH", "/_ui/api/users/"+adminID, map[string]any{"role": "admin"}), 200)
	ed.expect(ed.do("DELETE", "/_ui/api/users/"+id, nil, xhr), 204)
	if _, ok := ed.jar[session.CookieName]; ok {
		t.Fatal("self delete kept the cookie")
	}
	if len(h.store.Get().Users) != 1 {
		t.Fatal("not deleted")
	}
}

func TestPerUserEpochAndLogoutAll(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	h.createUser("vv", "viewer", "viewer-password")
	v1 := h.as("vv", "viewer-password")
	v2 := h.as("vv", "viewer-password")
	a2 := h.as("admin", adminPW)
	v1.expect(v1.do("POST", "/_ui/api/auth/logout-all", nil, xhr), 204)
	v2.expect(v2.do("GET", "/_ui/api/me", nil), 401)
	v1.expect(v1.do("GET", "/_ui/api/me", nil), 401)
	a2.expect(a2.do("GET", "/_ui/api/me", nil), 200) // other users unaffected
	h.expect(h.do("GET", "/_ui/api/me", nil), 200)
	// The global epoch still ends everybody's sessions.
	_ = h.store.Update(func(s *store.Settings) error { s.AuthEpoch++; return nil })
	h.expect(h.do("GET", "/_ui/api/me", nil), 401)
	a2.expect(a2.do("GET", "/_ui/api/me", nil), 401)
}

func TestMeEndpoints(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	me := decode[meResponse](t, h.do("GET", "/_ui/api/me", nil))
	if me.User.Username != "admin" || !me.User.PasswordSet || me.User.PasswordLocked || me.Identities == nil || me.Tokens == nil {
		t.Fatalf("me: %+v", me)
	}
	h.expect(h.do("PATCH", "/_ui/api/me", map[string]any{"name": "  Главный  "}), 204)
	if st := h.state(); st.User.Name != "Главный" {
		t.Fatalf("name: %q", st.User.Name)
	}
	if w := h.do("PATCH", "/_ui/api/me", map[string]any{"name": strings.Repeat("я", 65)}); w.Code != 400 {
		t.Fatalf("long name: %d", w.Code)
	}
	if w := h.do("PATCH", "/_ui/api/me", map[string]any{"role": "admin"}); w.Code != 400 {
		t.Fatalf("role via /me: %d", w.Code)
	}
	other := h.as("admin", adminPW)
	old := h.jar[session.CookieName]
	if w := h.do("POST", "/_ui/api/me/password", map[string]string{"current": "nope-nope", "new": "brand-new-pass"}); w.Code != 403 || errorCode(w) != "invalid_credentials" {
		t.Fatalf("wrong current: %d", w.Code)
	}
	if w := h.do("POST", "/_ui/api/me/password", map[string]string{"current": adminPW, "new": "short"}); w.Code != 400 || errorCode(w) != "password_too_short" {
		t.Fatalf("short: %d", w.Code)
	}
	h.expect(h.do("POST", "/_ui/api/me/password", map[string]string{"current": adminPW, "new": "brand-new-pass"}), 204)
	if h.jar[session.CookieName] == old {
		t.Fatal("caller's cookie not re-issued")
	}
	h.expect(h.do("GET", "/_ui/api/me", nil), 200)
	other.expect(other.do("GET", "/_ui/api/me", nil), 401)
	other.expect(other.login(adminPW), 401)
	other.expect(other.login("brand-new-pass"), 204)
	// Unlink of a provider that is not linked.
	h.expect(h.do("DELETE", "/_ui/api/me/identities/google", nil, xhr), 404)
}

func TestInvitesPassword(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	for _, bad := range []map[string]any{{"role": "root"}, {"role": "viewer", "expiresInDays": 31}, {"role": "viewer", "expiresInDays": 0}} {
		if w := h.do("POST", "/_ui/api/invites", bad); w.Code != 400 {
			t.Fatalf("%v: %d", bad, w.Code)
		}
	}
	w := h.do("POST", "/_ui/api/invites", map[string]any{"name": "Thero", "role": "editor"})
	h.expect(w, 201)
	inv := decode[createdInvite](t, w)
	if inv.ID == "" || inv.Role != "editor" || inv.Name != "Thero" || inv.ExpiresAt.Sub(inv.CreatedAt) != 7*24*time.Hour || !strings.HasSuffix(inv.URL, "/invite/"+inv.Token) {
		t.Fatalf("invite: %+v", inv)
	}
	if strings.Contains(string(mustJSON(h.store.Get())), inv.Token) {
		t.Fatal("invite token stored in plain text")
	}
	list := decode[[]inviteView](t, h.do("GET", "/_ui/api/invites", nil))
	if len(list) != 1 || list[0].ID != inv.ID {
		t.Fatalf("list: %+v", list)
	}
	if strings.Contains(h.do("GET", "/_ui/api/invites", nil).Body.String(), inv.Token) {
		t.Fatal("list shows the token")
	}

	anon := h.clone()
	pub := anon.do("GET", "/_ui/api/invites/"+inv.Token, nil)
	anon.expect(pub, 200)
	var p struct {
		Name, Role string
		ExpiresAt  time.Time
		Methods    stateMethods
	}
	p = decode[struct {
		Name, Role string
		ExpiresAt  time.Time
		Methods    stateMethods
	}](t, pub)
	if p.Name != "Thero" || p.Role != "editor" || !p.Methods.Password || p.Methods.Providers == nil {
		t.Fatalf("public: %+v", p)
	}
	for _, tok := range []string{"nope", strings.Repeat("a", 32), inv.Token + "x"} {
		if w := anon.do("GET", "/_ui/api/invites/"+tok, nil); w.Code != 404 || errorCode(w) != "invite_not_found" {
			t.Fatalf("%s: %d", tok, w.Code)
		}
	}
	// Bad input / taken user name: the invite stays.
	if w := anon.do("POST", "/_ui/api/invites/"+inv.Token+"/accept", map[string]string{"username": "admin", "password": "invitee-pass"}); w.Code != 409 || errorCode(w) != "username_taken" {
		t.Fatalf("taken: %d %s", w.Code, w.Body)
	}
	if w := anon.do("POST", "/_ui/api/invites/"+inv.Token+"/accept", map[string]string{"username": "thero", "password": "short"}); w.Code != 400 {
		t.Fatalf("short: %d", w.Code)
	}
	if w := anon.do("POST", "/_ui/api/invites/"+inv.Token+"/accept", "username=x", hdr("Content-Type", "application/x-www-form-urlencoded")); w.Code != 403 || errorCode(w) != "csrf" {
		t.Fatalf("csrf: %d", w.Code)
	}
	anon.expect(anon.do("POST", "/_ui/api/invites/"+inv.Token+"/accept", map[string]string{"username": "Thero", "password": "invitee-pass"}), 204)
	if st := anon.state(); st.User == nil || st.User.Username != "thero" || st.User.Role != "editor" || st.User.Name != "Thero" {
		t.Fatalf("accepted: %+v", st.User)
	}
	// Single use.
	if w := h.clone().do("POST", "/_ui/api/invites/"+inv.Token+"/accept", map[string]string{"username": "thero2", "password": "invitee-pass"}); w.Code != 404 {
		t.Fatalf("reuse: %d", w.Code)
	}
	// Expired → 410.
	inv2 := decode[createdInvite](t, h.do("POST", "/_ui/api/invites", map[string]any{"role": "viewer", "expiresInDays": 1}))
	h.srv.now = func() time.Time { return time.Now().Add(49 * time.Hour) }
	if w := anon.do("GET", "/_ui/api/invites/"+inv2.Token, nil); w.Code != 410 || errorCode(w) != "invite_expired" {
		t.Fatalf("expired: %d", w.Code)
	}
	if w := anon.do("POST", "/_ui/api/invites/"+inv2.Token+"/accept", map[string]string{"username": "late", "password": "invitee-pass"}); w.Code != 410 {
		t.Fatalf("expired accept: %d", w.Code)
	}
	if l := decode[[]inviteView](t, h.do("GET", "/_ui/api/invites", nil)); len(l) != 0 {
		t.Fatalf("expired listed: %+v", l)
	}
	h.srv.now = time.Now
	// Revoke.
	h.expect(h.do("DELETE", "/_ui/api/invites/"+inv2.ID, nil, xhr), 204)
	h.expect(h.do("DELETE", "/_ui/api/invites/"+inv2.ID, nil, xhr), 404)
	anon.expect(anon.do("GET", "/_ui/api/invites/"+inv2.Token, nil), 404)
	// Password login off → password accept refused.
	inv3 := decode[createdInvite](t, h.do("POST", "/_ui/api/invites", map[string]any{"role": "viewer"}))
	h.expect(h.put(map[string]any{"auth": map[string]any{"methods": map[string]any{"password": false, "header": true}, "header": map[string]any{"trusted": []string{"192.0.2.0/24"}}}}, hdr("Remote-User", "admin")), 200)
	if w := h.clone().do("POST", "/_ui/api/invites/"+inv3.Token+"/accept", map[string]string{"username": "late", "password": "invitee-pass"}); w.Code != 403 || errorCode(w) != "password_login_disabled" {
		t.Fatalf("password off: %d %s", w.Code, w.Body)
	}
}

func TestMigrationThroughServer(t *testing.T) {
	dir := t.TempDir()
	hash, _ := auth.HashPassword("old-v02-password")
	v1 := `{"version":1,"sessionKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","authEpoch":2,"auth":{"mode":"password","passwordHash":"` + hash + `"}}`
	if err := os.WriteFile(filepath.Join(dir, store.FileName), []byte(v1), 0o600); err != nil {
		t.Fatal(err)
	}
	h := newHarness(t, harnessOpt{env: map[string]string{"DATA_DIR": dir}})
	if st := h.state(); st.SetupRequired || !st.Methods.Password {
		t.Fatalf("%+v", st)
	}
	h.expect(h.login("old-v02-password"), 204)
	if st := h.state(); st.User.Username != "admin" || st.User.Role != "admin" {
		t.Fatalf("%+v", st.User)
	}
	if _, err := os.Stat(filepath.Join(dir, store.BackupV1Name)); err != nil {
		t.Fatal("no backup")
	}
	// A v0.2 session cookie ({u: "admin", m, e, x}) is not accepted.
	old := h.clone()
	old.jar[session.CookieName] = h.srv.sessions.Signer.Sign([]byte(`{"u":"admin","m":"password","e":2,"x":9999999999}`))
	old.expect(old.do("GET", "/_ui/api/me", nil), 401)
}

func TestSPARoutes(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	for _, p := range []string{"/profile", "/invite/AbCdEf0123456789AbCdEf0123456789", "/settings"} {
		w := h.do("GET", p, nil)
		if w.Code != 200 || !strings.Contains(w.Body.String(), "jackett-ui index") {
			t.Fatalf("%s: %d", p, w.Code)
		}
	}
}
