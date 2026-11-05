package httpapi

import (
	"net/http"
	"testing"

	"github.com/bropines/jackett-ui/server/internal/store"
)

const envPW = "env-password-1"

func envAdminHarness(t *testing.T) *harness {
	t.Helper()
	h := newHarness(t, harnessOpt{env: map[string]string{"AUTH_PASSWORD": envPW}})
	h.expect(h.login(envPW), http.StatusNoContent)
	return h
}

func TestOnboardingReplace(t *testing.T) {
	h := envAdminHarness(t)
	if !h.state().Onboarding {
		t.Fatal("onboarding not offered to the env admin")
	}
	admin := h.userByName("admin")
	if !admin.Bootstrap {
		t.Fatal("env admin not marked bootstrap")
	}
	// Validation.
	bad := []struct {
		body map[string]any
		code string
	}{
		{map[string]any{"mode": "nope"}, "invalid_value"},
		{map[string]any{"mode": "replace", "username": "X Y", "password": "long-enough-1"}, "invalid_username"},
		{map[string]any{"mode": "replace", "username": "me", "email": "not-mail", "password": "long-enough-1"}, "invalid_email"},
		{map[string]any{"mode": "replace", "username": "me", "password": "short"}, "password_too_short"},
	}
	for _, c := range bad {
		if w := h.do("POST", "/_ui/api/onboarding", c.body); errorCode(w) != c.code {
			t.Fatalf("%v: %d %s", c.body, w.Code, w.Body.String())
		}
	}
	h.expect(h.do("POST", "/_ui/api/onboarding", map[string]any{
		"mode": "replace", "username": "Bropines", "name": "Bro", "email": " Me@Example.com ", "password": "my-own-password",
	}), http.StatusNoContent)

	st := h.state()
	if st.Onboarding || st.User == nil || st.User.Username != "bropines" || st.User.Email != "me@example.com" || st.User.ID != admin.ID {
		t.Fatalf("after replace: %+v %+v", st, st.User)
	}
	u := h.userByName("bropines")
	if u.Bootstrap || u.PasswordHash == "" || u.Role != store.RoleAdmin || !h.store.Get().Onboarded {
		t.Fatalf("stored: %+v", u)
	}
	// The env password is dead, the new one works.
	if w := h.clone().loginAs("admin", envPW); w.Code != http.StatusUnauthorized {
		t.Fatalf("env password still works: %d", w.Code)
	}
	h.clone().expect(h.clone().loginAs("bropines", "my-own-password"), http.StatusNoContent)
	// A restart with the same env doesn't bring "admin" back.
	if err := ensureEnvAdmin(h.srv.env, h.store, h.srv.now(), h.srv.log); err != nil {
		t.Fatal(err)
	}
	if n := len(h.store.Get().Users); n != 1 {
		t.Fatalf("users after restart: %d", n)
	}
	// Second call: not onboarding anymore.
	if w := h.do("POST", "/_ui/api/onboarding", map[string]any{"mode": "skip"}); errorCode(w) != "not_onboarding" {
		t.Fatalf("repeat: %d", w.Code)
	}
	// The password is now changeable (not locked by env).
	me := decode[meResponse](t, h.do("GET", "/_ui/api/me", nil))
	if me.User.PasswordLocked || me.User.Bootstrap {
		t.Fatalf("me: %+v", me.User)
	}
}

func TestOnboardingAddAndSkip(t *testing.T) {
	h := envAdminHarness(t)
	h.createUser("taken", "viewer", "")
	if w := h.do("POST", "/_ui/api/onboarding", map[string]any{"mode": "add", "username": "taken", "password": "long-enough-1"}); errorCode(w) != "username_taken" {
		t.Fatalf("taken: %d", w.Code)
	}
	if w := h.do("POST", "/_ui/api/onboarding", map[string]any{"mode": "add", "username": "admin", "password": "long-enough-1"}); errorCode(w) != "username_taken" {
		t.Fatalf("add as admin: %d", w.Code)
	}
	h.expect(h.do("POST", "/_ui/api/onboarding", map[string]any{"mode": "add", "username": "bro", "password": "long-enough-1"}), http.StatusNoContent)
	st := h.state()
	if st.User == nil || st.User.Username != "bro" || st.User.Role != store.RoleAdmin || st.Onboarding {
		t.Fatalf("after add: %+v", st.User)
	}
	// admin keeps the env password.
	h.clone().expect(h.clone().login(envPW), http.StatusNoContent)
	if !h.userByName("admin").Bootstrap {
		t.Fatal("admin lost bootstrap")
	}
	// Deleting the initial admin is allowed now; the env password is then ignored.
	h.expect(h.do("DELETE", "/_ui/api/users/"+h.userByName("admin").ID, nil, xhr), http.StatusNoContent)
	if err := ensureEnvAdmin(h.srv.env, h.store, h.srv.now(), h.srv.log); err != nil {
		t.Fatal(err)
	}
	for _, u := range h.store.Get().Users {
		if u.Username == "admin" {
			t.Fatal("admin recreated after delete")
		}
	}

	s := envAdminHarness(t)
	s.expect(s.do("POST", "/_ui/api/onboarding", map[string]any{"mode": "skip"}), http.StatusNoContent)
	if s.state().Onboarding || !s.store.Get().Onboarded || !s.userByName("admin").Bootstrap {
		t.Fatal("skip")
	}
}

func TestOnboardingOnlyForBootstrap(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.expect(h.do("POST", "/_ui/api/auth/setup", map[string]any{"username": "boss", "name": "Boss", "email": "boss@x.io", "password": adminPW}), http.StatusNoContent)
	st := h.state()
	if st.Onboarding || st.User.Email != "boss@x.io" || st.User.Name != "Boss" || !h.store.Get().Onboarded {
		t.Fatalf("setup: %+v %+v", st, st.User)
	}
	if w := h.do("POST", "/_ui/api/onboarding", map[string]any{"mode": "skip"}); errorCode(w) != "not_onboarding" {
		t.Fatalf("onboarding for a setup admin: %d", w.Code)
	}
	if w := h.do("POST", "/_ui/api/auth/setup", map[string]any{"email": "bad", "password": adminPW}); w.Code != http.StatusConflict {
		t.Fatalf("second setup: %d", w.Code)
	}
}

func TestEmail(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	h.expect(h.do("PATCH", "/_ui/api/me", map[string]any{"email": "A@B.io"}), http.StatusNoContent)
	if h.userByName("admin").Email != "a@b.io" {
		t.Fatal("me email")
	}
	if w := h.do("POST", "/_ui/api/users", map[string]any{"username": "u2", "role": "viewer", "email": "a@b.io"}); errorCode(w) != "email_taken" {
		t.Fatalf("taken on create: %d", w.Code)
	}
	w := h.do("POST", "/_ui/api/users", map[string]any{"username": "u2", "role": "viewer", "email": "c@d.io"})
	h.expect(w, http.StatusCreated)
	u2 := decode[userView](t, w)
	if u2.Email != "c@d.io" || u2.PasskeyCount != 0 || u2.Bootstrap {
		t.Fatalf("view: %+v", u2)
	}
	if w := h.do("PATCH", "/_ui/api/users/"+u2.ID, map[string]any{"email": "a@b.io"}); errorCode(w) != "email_taken" {
		t.Fatalf("taken on patch: %d", w.Code)
	}
	if w := h.do("PATCH", "/_ui/api/users/"+u2.ID, map[string]any{"email": "x y@z"}); errorCode(w) != "invalid_email" {
		t.Fatalf("invalid: %d", w.Code)
	}
	h.expect(h.do("PATCH", "/_ui/api/users/"+u2.ID, map[string]any{"email": ""}), http.StatusOK)
	if h.userByName("u2").Email != "" {
		t.Fatal("clear email")
	}
	// Keeping your own e-mail is not a conflict.
	h.expect(h.do("PATCH", "/_ui/api/me", map[string]any{"email": "a@b.io"}), http.StatusNoContent)
}
