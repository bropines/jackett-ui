package httpapi

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/bropines/jackett-ui/server/internal/auth"
	"github.com/bropines/jackett-ui/server/internal/config"
	"github.com/bropines/jackett-ui/server/internal/jackett"
	"github.com/bropines/jackett-ui/server/internal/store"
	"github.com/bropines/jackett-ui/server/internal/users"
)

type stateProvider struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type stateMethods struct {
	Password  bool            `json:"password"`
	Providers []stateProvider `json:"providers"`
	Header    bool            `json:"header"`
}

type stateUser struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Name     string `json:"name"`
	Role     string `json:"role"`
}

type stateResponse struct {
	SetupRequired bool           `json:"setupRequired"`
	Authenticated bool           `json:"authenticated"`
	Disabled      bool           `json:"disabled"`
	User          *stateUser     `json:"user"`
	Methods       stateMethods   `json:"methods"`
	Jackett       jackett.Status `json:"jackett"`
	Version       string         `json:"version"`
}

func loginMethods(eff config.Effective) stateMethods {
	m := stateMethods{Password: eff.PasswordLogin(), Header: eff.HeaderLogin(), Providers: []stateProvider{}}
	for _, p := range eff.LoginProviders() {
		m.Providers = append(m.Providers, stateProvider{ID: p.ID, Name: p.Name.Value})
	}
	return m
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request, re *reqEnv) {
	eff := re.eff
	pr, fail := s.authenticate(w, r, re)
	resp := stateResponse{
		SetupRequired: eff.SetupRequired(),
		Authenticated: fail == "",
		Disabled:      eff.Disabled.Value,
		Methods:       loginMethods(eff),
		Version:       s.version,
	}
	if pr != nil && pr.user != nil {
		resp.User = &stateUser{ID: pr.user.ID, Username: pr.user.Username, Name: pr.user.Name, Role: pr.user.Role}
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

func passwordAPIError(err error, field string) error {
	switch {
	case errors.Is(err, auth.ErrPasswordTooShort):
		return &apiError{Status: http.StatusBadRequest, Code: "password_too_short", Message: "Пароль должен быть не короче 8 символов", Field: field}
	case errors.Is(err, auth.ErrPasswordTooLong):
		return &apiError{Status: http.StatusBadRequest, Code: "password_too_long", Message: "Пароль длиннее 72 байт", Field: field}
	}
	return err
}

// usernameArg normalises and validates a user name ("" = def).
func usernameArg(v, def, field string) (string, error) {
	v = users.NormalizeUsername(v)
	if v == "" {
		v = def
	}
	if !users.ValidUsername(v) {
		return "", &apiError{Status: http.StatusBadRequest, Code: "invalid_username", Message: "Имя пользователя: 2–32 символа, латиница в нижнем регистре, цифры, точка, _ и -", Field: field}
	}
	return v, nil
}

var errUsernameTaken = &apiError{Status: http.StatusConflict, Code: "username_taken", Message: "Такое имя пользователя уже занято", Field: "username"}

type credentialsBody struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request, re *reqEnv) {
	if !re.eff.SetupRequired() {
		writeErr(w, http.StatusConflict, "not_in_setup", "Администратор уже создан")
		return
	}
	if !s.rateLimit(w, r, re) {
		return
	}
	var body credentialsBody
	if err := decodeJSON(w, r, &body); err != nil {
		writeAPIError(w, err)
		return
	}
	name, err := usernameArg(body.Username, store.AdminUsername, "username")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	hash, err := auth.HashPassword(body.Password)
	if err != nil {
		writeAPIError(w, passwordAPIError(err, "password"))
		return
	}
	var u store.User
	err = s.store.Update(func(st *store.Settings) error {
		if len(st.Users) > 0 {
			return &apiError{Status: http.StatusConflict, Code: "not_in_setup", Message: "Администратор уже создан"}
		}
		u = newUser(name, "Администратор", store.RoleAdmin, hash, s.now())
		st.Users = append(st.Users, u)
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	s.limiter.Success(re.rv.ClientIP(r))
	s.log.Warn("first admin created via the setup wizard", "user", name, "ip", re.rv.ClientIP(r).String())
	// A setup session dies like a password session when password login is
	// switched off; "setup" only when the password method is off already.
	method := "password"
	if !re.eff.PasswordLogin() {
		method = methodSetup
	}
	if err := s.loginSucceeded(w, r, re, u.ID, method); err != nil {
		writeAPIError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// passwordHashOf: the env password wins for the user "admin".
func passwordHashOf(eff config.Effective, u *store.User) string {
	if u.Username == store.AdminUsername && eff.AdminPassword.Value != "" {
		return eff.AdminPassword.Value
	}
	return u.PasswordHash
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request, re *reqEnv) {
	eff := re.eff
	if !s.rateLimit(w, r, re) {
		return
	}
	if eff.SetupRequired() {
		writeErr(w, http.StatusConflict, failSetupRequired, "Сначала создайте администратора")
		return
	}
	if !eff.PasswordLogin() {
		writeErr(w, http.StatusForbidden, "password_login_disabled", "Вход по паролю отключён")
		return
	}
	var body credentialsBody
	if err := decodeJSON(w, r, &body); err != nil {
		writeAPIError(w, err)
		return
	}
	ip := re.rv.ClientIP(r)
	name := users.NormalizeUsername(body.Username)
	if name == "" {
		name = store.AdminUsername // v0.2 clients send only the password
	}
	u := users.ByUsername(&re.st, name)
	hash := ""
	if u != nil {
		hash = passwordHashOf(eff, u)
	}
	// CheckPassword with an empty hash burns comparable time.
	if !auth.CheckPassword(hash, body.Password) {
		s.limiter.Failure(ip)
		s.log.Warn("login failed", "ip", ip.String(), "method", "password", "user", clipName(name))
		writeErr(w, http.StatusUnauthorized, "invalid_credentials", "Неверное имя пользователя или пароль")
		return
	}
	s.limiter.Success(ip)
	if u.Disabled {
		writeAuthFail(w, failUserDisabled)
		return
	}
	if err := s.loginSucceeded(w, r, re, u.ID, "password"); err != nil {
		writeAPIError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request, re *reqEnv) {
	s.clearSession(w, r, re)
	s.log.Info("logout", "ip", re.rv.ClientIP(r).String())
	w.WriteHeader(http.StatusNoContent)
}

// bumpUserEpoch ends the sessions of user uid.
func (s *Server) bumpUserEpoch(uid string) error {
	return s.store.Update(func(st *store.Settings) error {
		u := st.User(uid)
		if u == nil {
			return errUserNotFound
		}
		u.Epoch++
		return nil
	})
}

var errUserNotFound = &apiError{Status: http.StatusNotFound, Code: "user_not_found", Message: "Пользователь не найден"}

func (s *Server) handleLogoutAll(w http.ResponseWriter, r *http.Request, re *reqEnv, pr *principal) {
	if pr.user == nil {
		writeAPIError(w, errNoUser)
		return
	}
	if err := s.bumpUserEpoch(pr.user.ID); err != nil {
		writeAPIError(w, err)
		return
	}
	s.log.Warn("logout on all devices", "user", pr.name(), "ip", re.rv.ClientIP(r).String())
	s.clearSession(w, r, re)
	w.WriteHeader(http.StatusNoContent)
}
