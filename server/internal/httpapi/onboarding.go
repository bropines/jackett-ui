package httpapi

import (
	"net/http"
	"strings"

	"github.com/bropines/jackett-ui/server/internal/auth"
	"github.com/bropines/jackett-ui/server/internal/store"
	"github.com/bropines/jackett-ui/server/internal/users"
)

// emailArg normalises and validates an optional e-mail ("" = none).
func emailArg(v, field string) (string, error) {
	v = users.NormalizeEmail(v)
	if v != "" && !users.ValidEmail(v) {
		return "", &apiError{Status: http.StatusBadRequest, Code: "invalid_email", Message: "Некорректный адрес почты", Field: field}
	}
	return v, nil
}

var errEmailTaken = &apiError{Status: http.StatusConflict, Code: "email_taken", Message: "Эта почта уже указана у другого пользователя", Field: "email"}

// emailTaken reports whether another user (not uid) has email.
func emailTaken(st *store.Settings, email, uid string) bool {
	u := users.ByEmail(st, email)
	return u != nil && u.ID != uid
}

// onboardingFor reports whether the first-login wizard is due for pr: the
// caller is the initial admin and the wizard hasn't run, or an admin whose
// password was reset from the command line.
func onboardingFor(st *store.Settings, pr *principal) bool {
	if pr == nil || pr.user == nil {
		return false
	}
	return onboardingDue(st, st.User(pr.user.ID))
}

func onboardingDue(st *store.Settings, u *store.User) bool {
	if u == nil || u.Disabled {
		return false
	}
	return (u.Bootstrap && !st.Onboarded) || (u.Onboard && u.Role == store.RoleAdmin)
}

var errNotOnboarding = &apiError{Status: http.StatusConflict, Code: "not_onboarding", Message: "Первичная настройка уже пройдена"}

// handleOnboarding: POST /onboarding — replace the initial admin with the
// caller's own account, add a second admin, or skip.
func (s *Server) handleOnboarding(w http.ResponseWriter, r *http.Request, re *reqEnv, pr *principal) {
	if !onboardingFor(&re.st, pr) {
		writeAPIError(w, errNotOnboarding)
		return
	}
	var body struct {
		Mode     string `json:"mode"`
		Username string `json:"username"`
		Name     string `json:"name"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeAPIError(w, err)
		return
	}
	uid := pr.user.ID
	if body.Mode == "skip" {
		err := s.store.Update(func(st *store.Settings) error {
			st.Onboarded = true
			if me := st.User(uid); me != nil {
				me.Onboard = false
			}
			return nil
		})
		if err != nil {
			writeAPIError(w, err)
			return
		}
		s.log.Info("first-login wizard skipped", "user", pr.name())
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if body.Mode != "replace" && body.Mode != "add" {
		writeAPIError(w, badField("mode", "Режим: replace, add или skip"))
		return
	}
	name, err := usernameArg(body.Username, "", "username")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	email, err := emailArg(body.Email, "email")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	display := strings.TrimSpace(body.Name)
	if display == "" {
		display = name
	}
	if !users.ValidName(display) {
		writeAPIError(w, badField("name", "Недопустимое имя"))
		return
	}
	hash, err := auth.HashPassword(body.Password)
	if err != nil {
		writeAPIError(w, passwordAPIError(err, "password"))
		return
	}

	var nu store.User
	err = s.store.Update(func(st *store.Settings) error {
		me := st.User(uid)
		if !onboardingDue(st, me) {
			return errNotOnboarding
		}
		me.Onboard = false
		if other := users.ByUsername(st, name); other != nil && (body.Mode == "add" || other.ID != uid) {
			return errUsernameTaken
		}
		if body.Mode == "add" {
			if emailTaken(st, email, "") {
				return errEmailTaken
			}
			nu = newUser(name, display, store.RoleAdmin, hash, s.now())
			nu.Email = email
			st.Users = append(st.Users, nu)
		} else {
			if emailTaken(st, email, uid) {
				return errEmailTaken
			}
			me.Username, me.Name, me.Email = name, display, email
			me.PasswordHash, me.Bootstrap = hash, false
			me.Role, me.Disabled = store.RoleAdmin, false
			me.Epoch++
			nu = *me
		}
		st.Onboarded = true
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	s.log.Warn("first-login wizard finished", "mode", body.Mode, "user", nu.Username, "by", pr.name(), "ip", re.rv.ClientIP(r).String())
	if body.Mode == "add" {
		if err := s.loginSucceeded(w, r, re, nu.ID, "password"); err != nil {
			writeAPIError(w, err)
			return
		}
	} else if pr.via == viaSession {
		s.issueSession(w, r, re, &nu, pr.sess.Method)
	}
	w.WriteHeader(http.StatusNoContent)
}
