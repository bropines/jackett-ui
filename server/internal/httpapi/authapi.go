package httpapi

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/bropines/jackett-ui/server/internal/auth"
	"github.com/bropines/jackett-ui/server/internal/config"
	"github.com/bropines/jackett-ui/server/internal/jackett"
	"github.com/bropines/jackett-ui/server/internal/store"
)

type stateProvider struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type stateResponse struct {
	Mode          string          `json:"mode"`
	SetupRequired bool            `json:"setupRequired"`
	Authenticated bool            `json:"authenticated"`
	User          string          `json:"user,omitempty"`
	PasswordLogin bool            `json:"passwordLogin"`
	Providers     []stateProvider `json:"providers"`
	Jackett       jackett.Status  `json:"jackett"`
	Version       string          `json:"version"`
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request, re *reqEnv) {
	eff := re.eff
	id, fail := s.authenticate(w, r, re)
	resp := stateResponse{
		Mode:          eff.Mode.Value,
		SetupRequired: eff.SetupRequired(),
		Authenticated: fail == "",
		User:          id.User,
		PasswordLogin: eff.PasswordLogin(),
		Providers:     []stateProvider{},
		Version:       s.version,
	}
	for _, p := range eff.LoginProviders() {
		resp.Providers = append(resp.Providers, stateProvider{ID: p.ID, Name: p.Name.Value})
	}
	if s.jc != nil {
		resp.Jackett = s.jc.Status(r.Context())
		if !resp.Authenticated {
			// Don't tell anonymous callers which Jackett version runs.
			resp.Jackett.Version = ""
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// rateLimit applies the login limiter; false = answered 429.
func (s *Server) rateLimit(w http.ResponseWriter, r *http.Request, re *reqEnv) bool {
	ok, wait := s.limiter.Allow(re.rv.ClientIP(r))
	if !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())))
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "Слишком много попыток, подождите")
		return false
	}
	return true
}

type passwordBody struct {
	Password string `json:"password"`
}

func passwordAPIError(err error) error {
	switch {
	case errors.Is(err, auth.ErrPasswordTooShort):
		return &apiError{Status: http.StatusBadRequest, Code: "password_too_short", Message: "Пароль должен быть не короче 8 символов", Field: "password"}
	case errors.Is(err, auth.ErrPasswordTooLong):
		return &apiError{Status: http.StatusBadRequest, Code: "password_too_long", Message: "Пароль длиннее 72 байт", Field: "password"}
	}
	return err
}

func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request, re *reqEnv) {
	if !re.eff.SetupRequired() {
		writeErr(w, http.StatusConflict, "not_in_setup", "Пароль уже задан")
		return
	}
	if !s.rateLimit(w, r, re) {
		return
	}
	var body passwordBody
	if err := decodeJSON(w, r, &body); err != nil {
		writeAPIError(w, err)
		return
	}
	hash, err := auth.HashPassword(body.Password)
	if err != nil {
		writeAPIError(w, passwordAPIError(err))
		return
	}
	var epoch uint64
	err = s.store.Update(func(st *store.Settings) error {
		cur, err := config.Resolve(s.env, *st)
		if err != nil {
			return err
		}
		if !cur.SetupRequired() {
			return &apiError{Status: http.StatusConflict, Code: "not_in_setup", Message: "Пароль уже задан"}
		}
		st.Auth.PasswordHash = hash
		if st.Auth.Mode == "" {
			st.Auth.Mode = auth.ModePassword
		}
		epoch = st.AuthEpoch
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	s.limiter.Success(re.rv.ClientIP(r))
	s.log.Warn("admin password set via the setup wizard", "ip", re.rv.ClientIP(r).String())
	s.issueSession(w, r, re, auth.AdminUser, auth.ModePassword, epoch)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request, re *reqEnv) {
	eff := re.eff
	if !s.rateLimit(w, r, re) {
		return
	}
	if eff.SetupRequired() {
		writeErr(w, http.StatusConflict, failSetupRequired, "Сначала задайте пароль администратора")
		return
	}
	if !eff.PasswordLogin() {
		writeErr(w, http.StatusForbidden, "password_login_disabled", "Вход по паролю отключён")
		return
	}
	var body passwordBody
	if err := decodeJSON(w, r, &body); err != nil {
		writeAPIError(w, err)
		return
	}
	ip := re.rv.ClientIP(r)
	if !auth.CheckPassword(eff.PasswordHash.Value, body.Password) {
		s.limiter.Failure(ip)
		s.log.Warn("login failed", "ip", ip.String(), "method", "password")
		writeErr(w, http.StatusUnauthorized, "invalid_credentials", "Неверный пароль")
		return
	}
	s.limiter.Success(ip)
	s.log.Info("login ok", "ip", ip.String(), "user", auth.AdminUser, "method", "password")
	s.issueSession(w, r, re, auth.AdminUser, eff.Mode.Value, eff.Epoch)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request, re *reqEnv) {
	s.clearSession(w, r, re)
	s.log.Info("logout", "ip", re.rv.ClientIP(r).String())
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleLogoutAll(w http.ResponseWriter, r *http.Request, re *reqEnv, id auth.Identity) {
	err := s.store.Update(func(st *store.Settings) error {
		st.AuthEpoch++
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	s.log.Warn("logout on all devices", "user", id.User, "ip", re.rv.ClientIP(r).String())
	s.clearSession(w, r, re)
	w.WriteHeader(http.StatusNoContent)
}
