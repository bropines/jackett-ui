package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/bropines/jackett-ui/server/internal/auth"
	"github.com/bropines/jackett-ui/server/internal/config"
	"github.com/bropines/jackett-ui/server/internal/store"
	"github.com/bropines/jackett-ui/server/internal/users"
)

// ---- views ----

type identityView struct {
	Provider string    `json:"provider"`
	Label    string    `json:"label"`
	LinkedAt time.Time `json:"linkedAt"`
}

type tokenView struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
	LastUsedIP string     `json:"lastUsedIp"`
	ExpiresAt  *time.Time `json:"expiresAt"`
}

type userView struct {
	ID             string         `json:"id"`
	Username       string         `json:"username"`
	Name           string         `json:"name"`
	Email          string         `json:"email"`
	Role           string         `json:"role"`
	Bootstrap      bool           `json:"bootstrap"`
	PasskeyCount   int            `json:"passkeyCount"`
	Disabled       bool           `json:"disabled"`
	PasswordSet    bool           `json:"passwordSet"`
	PasswordLocked bool           `json:"passwordLocked"`
	Identities     []identityView `json:"identities"`
	TokenCount     int            `json:"tokenCount"`
	CreatedAt      time.Time      `json:"createdAt"`
	LastLoginAt    *time.Time     `json:"lastLoginAt"`
}

func identitiesView(u *store.User) []identityView {
	out := []identityView{}
	for _, id := range u.Identities {
		out = append(out, identityView{Provider: id.Provider, Label: id.Label, LinkedAt: id.LinkedAt})
	}
	return out
}

func userViewOf(eff config.Effective, st *store.Settings, u *store.User) userView {
	locked := envPassword(eff, u)
	return userView{
		ID: u.ID, Username: u.Username, Name: u.Name, Email: u.Email, Role: u.Role, Disabled: u.Disabled,
		Bootstrap: u.Bootstrap, PasskeyCount: len(u.Passkeys),
		PasswordSet: passwordHashOf(eff, u) != "", PasswordLocked: locked,
		Identities: identitiesView(u), TokenCount: users.TokenCount(st, u.ID),
		CreatedAt: u.CreatedAt, LastLoginAt: u.LastLoginAt,
	}
}

func (s *Server) tokensOf(st *store.Settings, uid string) []tokenView {
	out := []tokenView{}
	for _, t := range st.Tokens {
		if t.UserID != uid {
			continue
		}
		s.liveUsage(&t)
		out = append(out, tokenView{ID: t.ID, Name: t.Name, Prefix: t.Prefix, CreatedAt: t.CreatedAt,
			LastUsedAt: t.LastUsedAt, LastUsedIP: t.LastUsedIP, ExpiresAt: t.ExpiresAt})
	}
	return out
}

func badField(field, msg string) error {
	return &apiError{Status: http.StatusBadRequest, Code: "invalid_value", Message: msg, Field: field}
}

func conflict(code, msg string) error {
	return &apiError{Status: http.StatusConflict, Code: code, Message: msg}
}

func lockedErr(field, env string) error {
	msg := "Значение задано переменной окружения"
	if env != "" {
		msg += " " + env
	}
	return &apiError{Status: http.StatusConflict, Code: "locked", Message: msg, Field: field}
}

// ---- me ----

type meResponse struct {
	User       userView       `json:"user"`
	Identities []identityView `json:"identities"`
	Tokens     []tokenView    `json:"tokens"`
}

func (s *Server) handleMe(w http.ResponseWriter, _ *http.Request, re *reqEnv, pr *principal) {
	if pr.user == nil {
		writeAPIError(w, errNoUser)
		return
	}
	u := re.st.User(pr.user.ID)
	writeJSON(w, http.StatusOK, meResponse{User: userViewOf(re.eff, &re.st, u), Identities: identitiesView(u), Tokens: s.tokensOf(&re.st, u.ID)})
}

func (s *Server) handleMePatch(w http.ResponseWriter, r *http.Request, re *reqEnv, pr *principal) {
	if pr.user == nil {
		writeAPIError(w, errNoUser)
		return
	}
	var body struct {
		Name  opt[string] `json:"name"`
		Email opt[string] `json:"email"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeAPIError(w, err)
		return
	}
	name := strings.TrimSpace(body.Name.V)
	if body.Name.Set && !users.ValidName(name) {
		writeAPIError(w, badField("name", "Недопустимое имя"))
		return
	}
	email, err := emailArg(body.Email.V, "email")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if body.Name.Set || body.Email.Set {
		err := s.store.Update(func(st *store.Settings) error {
			u := st.User(pr.user.ID)
			if u == nil {
				return errUserNotFound
			}
			if body.Name.Set {
				u.Name = name
			}
			if body.Email.Set {
				if emailTaken(st, email, u.ID) {
					return errEmailTaken
				}
				u.Email = email
			}
			return nil
		})
		if err != nil {
			writeAPIError(w, err)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleMePassword(w http.ResponseWriter, r *http.Request, re *reqEnv, pr *principal) {
	if pr.user == nil {
		writeAPIError(w, errNoUser)
		return
	}
	var body struct {
		Current string `json:"current"`
		New     string `json:"new"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeAPIError(w, err)
		return
	}
	u := re.st.User(pr.user.ID)
	if envPassword(re.eff, u) {
		writeAPIError(w, lockedErr("new", re.eff.AdminPassword.Env))
		return
	}
	ip := re.rv.ClientIP(r)
	if u.PasswordHash != "" {
		if !s.rateLimit(w, r, re) {
			return
		}
		if !auth.CheckPassword(u.PasswordHash, body.Current) {
			s.limiter.Failure(ip)
			s.log.Warn("password change: wrong current password", "user", u.Username, "ip", ip.String())
			writeAPIError(w, &apiError{Status: http.StatusForbidden, Code: "invalid_credentials", Message: "Текущий пароль неверен", Field: "current"})
			return
		}
		s.limiter.Success(ip)
	}
	hash, err := auth.HashPassword(body.New)
	if err != nil {
		writeAPIError(w, passwordAPIError(err, "new"))
		return
	}
	var nu store.User
	err = s.store.Update(func(st *store.Settings) error {
		p := st.User(u.ID)
		if p == nil {
			return errUserNotFound
		}
		if p.PasswordHash != u.PasswordHash {
			return conflict("conflict", "Пароль изменился, повторите попытку")
		}
		p.PasswordHash = hash
		p.Epoch++
		nu = *p
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	s.log.Warn("password changed", "user", u.Username, "ip", ip.String())
	// Other sessions die (epoch); the caller keeps a fresh one.
	if pr.via == viaSession {
		s.issueSession(w, r, re, &nu, pr.sess.Method)
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleUnlink removes the identity of provider from user uid. A user
// unlinking from themselves must keep a way to log in.
func (s *Server) handleUnlink(w http.ResponseWriter, r *http.Request, re *reqEnv, pr *principal, uid, provider string) {
	if uid == "" {
		writeAPIError(w, errNoUser)
		return
	}
	err := s.store.Update(func(st *store.Settings) error {
		u := st.User(uid)
		if u == nil {
			return errUserNotFound
		}
		idx := -1
		for i, id := range u.Identities {
			if id.Provider == provider {
				idx = i
			}
		}
		if idx < 0 {
			return &apiError{Status: http.StatusNotFound, Code: "identity_not_found", Message: "Такой привязки нет"}
		}
		u.Identities = append(u.Identities[:idx], u.Identities[idx+1:]...)
		if uid == pr.uid() {
			eff, err := config.Resolve(s.env, *st)
			if err != nil {
				return err
			}
			if !canLogIn(eff, eff.AdminPassword.Value != "", u, true) {
				return errWouldLockOut("После отвязки вам будет нечем войти: задайте пароль или привяжите другой аккаунт")
			}
		}
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	s.log.Info("identity unlinked", "user", uid, "provider", provider, "by", pr.name())
	w.WriteHeader(http.StatusNoContent)
}

// ---- tokens ----

func (s *Server) handleMyTokens(w http.ResponseWriter, re *reqEnv, pr *principal) {
	if pr.user == nil {
		writeAPIError(w, errNoUser)
		return
	}
	writeJSON(w, http.StatusOK, s.tokensOf(&re.st, pr.user.ID))
}

type createdToken struct {
	Token string `json:"token"`
	tokenView
}

const maxTokenDays = 3650

func (s *Server) handleTokenCreate(w http.ResponseWriter, r *http.Request, re *reqEnv, pr *principal) {
	if pr.user == nil {
		writeAPIError(w, errNoUser)
		return
	}
	var body struct {
		Name          string `json:"name"`
		ExpiresInDays *int   `json:"expiresInDays"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeAPIError(w, err)
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || !validText(name, 4*users.MaxTokenNameLen) || len([]rune(name)) > users.MaxTokenNameLen {
		writeAPIError(w, badField("name", "Название токена: 1–64 символа"))
		return
	}
	now := s.now().UTC().Truncate(time.Second)
	var exp *time.Time
	if body.ExpiresInDays != nil {
		d := *body.ExpiresInDays
		if d < 1 || d > maxTokenDays {
			writeAPIError(w, badField("expiresInDays", "Срок: от 1 до 3650 дней"))
			return
		}
		e := now.AddDate(0, 0, d)
		exp = &e
	}
	tok, prefix, hash := users.NewToken()
	t := store.Token{ID: store.NewID("t_"), UserID: pr.user.ID, Name: name, Prefix: prefix, Hash: hash, CreatedAt: now, ExpiresAt: exp}
	err := s.store.Update(func(st *store.Settings) error {
		if st.User(pr.user.ID) == nil {
			return errUserNotFound
		}
		if users.TokenCount(st, pr.user.ID) >= users.MaxTokensPerUser {
			return conflict("too_many_tokens", "Не больше 20 токенов на пользователя")
		}
		st.Tokens = append(st.Tokens, t)
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	s.log.Info("api token created", "user", pr.name(), "token", t.ID, "ip", re.rv.ClientIP(r).String())
	writeJSON(w, http.StatusCreated, createdToken{Token: tok, tokenView: tokenView{ID: t.ID, Name: t.Name, Prefix: t.Prefix, CreatedAt: t.CreatedAt, ExpiresAt: t.ExpiresAt}})
}

// handleTokenDelete revokes a token: own only (me) or any (admin).
func (s *Server) handleTokenDelete(w http.ResponseWriter, r *http.Request, re *reqEnv, pr *principal, id string, own bool) {
	if own && pr.user == nil {
		writeAPIError(w, errNoUser)
		return
	}
	err := s.store.Update(func(st *store.Settings) error {
		for i, t := range st.Tokens {
			if t.ID == id && (!own || t.UserID == pr.user.ID) {
				st.Tokens = append(st.Tokens[:i], st.Tokens[i+1:]...)
				return nil
			}
		}
		return &apiError{Status: http.StatusNotFound, Code: "token_not_found", Message: "Токен не найден"}
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	s.log.Info("api token revoked", "token", id, "by", pr.name(), "ip", re.rv.ClientIP(r).String())
	w.WriteHeader(http.StatusNoContent)
}

// ---- users (admin) ----

func (s *Server) handleUsersList(w http.ResponseWriter, re *reqEnv) {
	out := []userView{}
	for i := range re.st.Users {
		out = append(out, userViewOf(re.eff, &re.st, &re.st.Users[i]))
	}
	writeJSON(w, http.StatusOK, out)
}

func roleArg(v, field string) (string, error) {
	v = strings.ToLower(strings.TrimSpace(v))
	if !config.ValidRole(v) {
		return "", badField(field, "Роль: viewer, editor или admin")
	}
	return v, nil
}

func (s *Server) handleUserCreate(w http.ResponseWriter, r *http.Request, re *reqEnv, pr *principal) {
	var body struct {
		Username string `json:"username"`
		Name     string `json:"name"`
		Email    string `json:"email"`
		Role     string `json:"role"`
		Password string `json:"password"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeAPIError(w, err)
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
	role, err := roleArg(body.Role, "role")
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
	hash := ""
	if body.Password != "" {
		if hash, err = auth.HashPassword(body.Password); err != nil {
			writeAPIError(w, passwordAPIError(err, "password"))
			return
		}
	}
	var u store.User
	err = s.store.Update(func(st *store.Settings) error {
		if users.ByUsername(st, name) != nil {
			return errUsernameTaken
		}
		if emailTaken(st, email, "") {
			return errEmailTaken
		}
		u = newUser(name, display, role, hash, s.now())
		u.Email = email
		st.Users = append(st.Users, u)
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	s.log.Warn("user created", "user", name, "role", role, "by", pr.name())
	st := s.store.Get()
	writeJSON(w, http.StatusCreated, userViewOf(re.eff, &st, st.User(u.ID)))
}

func (s *Server) handleUserPatch(w http.ResponseWriter, r *http.Request, re *reqEnv, pr *principal, id string) {
	var body struct {
		Name     opt[string] `json:"name"`
		Role     opt[string] `json:"role"`
		Email    opt[string] `json:"email"`
		Disabled opt[bool]   `json:"disabled"`
		Password opt[string] `json:"password"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeAPIError(w, err)
		return
	}
	var role, name, hash string
	var err error
	if body.Role.Set {
		if role, err = roleArg(body.Role.V, "role"); err != nil {
			writeAPIError(w, err)
			return
		}
	}
	if body.Name.Set {
		name = strings.TrimSpace(body.Name.V)
		if !users.ValidName(name) {
			writeAPIError(w, badField("name", "Недопустимое имя"))
			return
		}
	}
	email, err := emailArg(body.Email.V, "email")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if body.Password.Set && !body.Password.Null {
		if hash, err = auth.HashPassword(body.Password.V); err != nil {
			writeAPIError(w, passwordAPIError(err, "password"))
			return
		}
	}
	var nu store.User
	err = s.store.Update(func(st *store.Settings) error {
		u := st.User(id)
		if u == nil {
			return errUserNotFound
		}
		bump := false
		if body.Name.Set {
			u.Name = name
		}
		if body.Email.Set {
			if emailTaken(st, email, u.ID) {
				return errEmailTaken
			}
			u.Email = email
		}
		if body.Role.Set && role != u.Role {
			u.Role, bump = role, true
		}
		if body.Disabled.Set && body.Disabled.V != u.Disabled {
			u.Disabled, bump = body.Disabled.V, true
		}
		if body.Password.Set {
			if envPassword(re.eff, u) {
				return lockedErr("password", re.eff.AdminPassword.Env)
			}
			u.PasswordHash, bump = hash, true // null clears the password
		}
		if users.EnabledAdmins(st) == 0 {
			return errLastAdmin
		}
		if bump {
			u.Epoch++
		}
		nu = *u
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	s.log.Warn("user changed", "user", nu.Username, "role", nu.Role, "disabled", nu.Disabled, "by", pr.name())
	if id == pr.uid() && pr.via == viaSession {
		if nu.Disabled {
			s.clearSession(w, r, re)
		} else {
			s.issueSession(w, r, re, &nu, pr.sess.Method)
		}
	}
	st := s.store.Get()
	writeJSON(w, http.StatusOK, userViewOf(re.eff, &st, st.User(id)))
}

func (s *Server) handleUserDelete(w http.ResponseWriter, r *http.Request, re *reqEnv, pr *principal, id string) {
	var name string
	err := s.store.Update(func(st *store.Settings) error {
		u := st.User(id)
		if u == nil {
			return errUserNotFound
		}
		// Without the initial admin the env password has nobody to log in.
		if u.Bootstrap {
			st.Onboarded = true
		}
		name = u.Username
		users.DeleteTokensOf(st, id)
		for i := range st.Users {
			if st.Users[i].ID == id {
				st.Users = append(st.Users[:i], st.Users[i+1:]...)
				break
			}
		}
		if users.EnabledAdmins(st) == 0 {
			return errLastAdmin
		}
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	s.log.Warn("user deleted", "user", name, "by", pr.name())
	if id == pr.uid() {
		s.clearSession(w, r, re)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleUserLogout(w http.ResponseWriter, r *http.Request, re *reqEnv, pr *principal, id string) {
	if err := s.bumpUserEpoch(id); err != nil {
		writeAPIError(w, err)
		return
	}
	s.log.Warn("user sessions ended", "user", id, "by", pr.name())
	if id == pr.uid() {
		s.clearSession(w, r, re)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleUserTokens(w http.ResponseWriter, re *reqEnv, id string) {
	if re.st.User(id) == nil {
		writeAPIError(w, errUserNotFound)
		return
	}
	writeJSON(w, http.StatusOK, s.tokensOf(&re.st, id))
}

// ---- invites ----

type inviteView struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Role      string    `json:"role"`
	CreatedBy string    `json:"createdBy"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type createdInvite struct {
	inviteView
	URL   string `json:"url"`
	Token string `json:"token"`
}

const (
	defaultInviteDays = 7
	maxInviteDays     = 30
)

func inviteViewOf(i store.Invite) inviteView {
	return inviteView{ID: i.ID, Name: i.Name, Role: i.Role, CreatedBy: i.CreatedBy, CreatedAt: i.CreatedAt, ExpiresAt: i.ExpiresAt}
}

func (s *Server) handleInvitesList(w http.ResponseWriter, re *reqEnv) {
	out := []inviteView{}
	now := s.now()
	for _, i := range re.st.Invites {
		if now.Before(i.ExpiresAt) {
			out = append(out, inviteViewOf(i))
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleInviteCreate(w http.ResponseWriter, r *http.Request, re *reqEnv, pr *principal) {
	var body struct {
		Name          string `json:"name"`
		Role          string `json:"role"`
		ExpiresInDays *int   `json:"expiresInDays"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeAPIError(w, err)
		return
	}
	role, err := roleArg(body.Role, "role")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	name := strings.TrimSpace(body.Name)
	if !users.ValidName(name) {
		writeAPIError(w, badField("name", "Недопустимое имя"))
		return
	}
	days := defaultInviteDays
	if body.ExpiresInDays != nil {
		days = *body.ExpiresInDays
	}
	if days < 1 || days > maxInviteDays {
		writeAPIError(w, badField("expiresInDays", "Срок приглашения: от 1 до 30 дней"))
		return
	}
	now := s.now().UTC().Truncate(time.Second)
	secret, hash := users.NewInviteSecret()
	inv := store.Invite{ID: store.NewID("i_"), Hash: hash, Role: role, Name: name, CreatedBy: pr.uid(), CreatedAt: now, ExpiresAt: now.AddDate(0, 0, days)}
	err = s.store.Update(func(st *store.Settings) error {
		users.PruneInvites(st, now)
		if len(st.Invites) >= 100 {
			return conflict("too_many_invites", "Слишком много действующих приглашений")
		}
		st.Invites = append(st.Invites, inv)
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	s.log.Warn("invite created", "invite", inv.ID, "role", role, "by", pr.name())
	writeJSON(w, http.StatusCreated, createdInvite{inviteView: inviteViewOf(inv), URL: re.rv.Origin(r) + "/invite/" + secret, Token: secret})
}

func (s *Server) handleInviteDelete(w http.ResponseWriter, _ *http.Request, _ *reqEnv, pr *principal, id string) {
	err := s.store.Update(func(st *store.Settings) error {
		for i, inv := range st.Invites {
			if inv.ID == id {
				st.Invites = append(st.Invites[:i], st.Invites[i+1:]...)
				return nil
			}
		}
		return errInviteNotFound
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	s.log.Info("invite revoked", "invite", id, "by", pr.name())
	w.WriteHeader(http.StatusNoContent)
}

var (
	errInviteNotFound = &apiError{Status: http.StatusNotFound, Code: "invite_not_found", Message: "Приглашение не найдено или уже использовано"}
	errInviteExpired  = &apiError{Status: http.StatusGone, Code: "invite_expired", Message: "Срок приглашения истёк"}
)

// inviteFor finds a pending invite by secret (or by secret hash).
func (s *Server) inviteFor(st *store.Settings, secret, hash string) (*store.Invite, error) {
	var inv *store.Invite
	if hash != "" {
		inv = users.FindInviteByHash(st, hash)
	} else {
		inv = users.FindInvite(st, secret)
	}
	if inv == nil {
		return nil, errInviteNotFound
	}
	if !s.now().Before(inv.ExpiresAt) {
		return nil, errInviteExpired
	}
	return inv, nil
}

// inviteMethods: how an invite can be accepted (login must be on).
func inviteMethods(eff config.Effective) stateMethods {
	m := loginMethods(eff)
	m.Header = false
	return m
}

func (s *Server) handleInvitePublic(w http.ResponseWriter, _ *http.Request, re *reqEnv, secret string) {
	inv, err := s.inviteFor(&re.st, secret, "")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"name": inv.Name, "role": inv.Role, "expiresAt": inv.ExpiresAt, "methods": inviteMethods(re.eff)})
}

func (s *Server) handleInviteAccept(w http.ResponseWriter, r *http.Request, re *reqEnv, secret string) {
	if !s.rateLimit(w, r, re) {
		return
	}
	if _, err := s.inviteFor(&re.st, secret, ""); err != nil {
		writeAPIError(w, err)
		return
	}
	if !re.eff.PasswordLogin() {
		writeErr(w, http.StatusForbidden, "password_login_disabled", "Вход по паролю отключён: примите приглашение через внешний аккаунт")
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Name     string `json:"name"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeAPIError(w, err)
		return
	}
	name, err := usernameArg(body.Username, "", "username")
	if err != nil {
		writeAPIError(w, err)
		return
	}
	display := strings.TrimSpace(body.Name)
	if !users.ValidName(display) {
		writeAPIError(w, badField("name", "Недопустимое имя"))
		return
	}
	hash, err := auth.HashPassword(body.Password)
	if err != nil {
		writeAPIError(w, passwordAPIError(err, "password"))
		return
	}
	var u store.User
	err = s.store.Update(func(st *store.Settings) error {
		inv, err := s.inviteFor(st, secret, "")
		if err != nil {
			return err
		}
		if users.ByUsername(st, name) != nil {
			return errUsernameTaken
		}
		if display == "" {
			display = inv.Name
		}
		if display == "" {
			display = name
		}
		u = newUser(name, display, inv.Role, hash, s.now())
		st.Users = append(st.Users, u)
		removeInvite(st, inv.ID)
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	s.limiter.Success(re.rv.ClientIP(r))
	s.log.Warn("invite accepted", "user", name, "role", u.Role, "ip", re.rv.ClientIP(r).String())
	if err := s.loginSucceeded(w, r, re, u.ID, "password"); err != nil {
		writeAPIError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func removeInvite(st *store.Settings, id string) {
	for i := range st.Invites {
		if st.Invites[i].ID == id {
			st.Invites = append(st.Invites[:i], st.Invites[i+1:]...)
			return
		}
	}
}
