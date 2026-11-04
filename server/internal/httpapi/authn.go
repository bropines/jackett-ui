package httpapi

import (
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/bropines/jackett-ui/server/internal/auth"
	"github.com/bropines/jackett-ui/server/internal/config"
	"github.com/bropines/jackett-ui/server/internal/session"
	"github.com/bropines/jackett-ui/server/internal/store"
	"github.com/bropines/jackett-ui/server/internal/users"
)

// How a principal was authenticated.
const (
	viaSession  = "session"
	viaHeader   = "header"
	viaDisabled = "disabled" // login is off: anonymous admin
	viaToken    = "token"
)

// Session methods besides the login method ids.
const methodSetup = "setup"

// principal is an authenticated caller.
type principal struct {
	user  *store.User // nil: anonymous (login disabled)
	role  string
	via   string
	sess  session.Session
	token *store.Token
}

func (p *principal) uid() string {
	if p.user == nil {
		return ""
	}
	return p.user.ID
}

func (p *principal) name() string {
	if p.user == nil {
		return "anonymous"
	}
	return p.user.Username
}

func (p *principal) isAdmin() bool { return p.role == store.RoleAdmin }

const (
	failUnauthorized  = "unauthorized"
	failSetupRequired = "setup_required"
	failUserDisabled  = "user_disabled"
	failNotAllowed    = "user_not_allowed"
)

func writeAuthFail(w http.ResponseWriter, code string) {
	switch code {
	case failSetupRequired:
		writeErr(w, http.StatusUnauthorized, failSetupRequired, "Сначала создайте администратора")
	case failUserDisabled:
		writeErr(w, http.StatusUnauthorized, failUserDisabled, "Учётная запись отключена")
	case failNotAllowed:
		writeErr(w, http.StatusUnauthorized, failNotAllowed, "Пользователя нет в списке разрешённых")
	default:
		writeErr(w, http.StatusUnauthorized, failUnauthorized, "Нужно войти")
	}
}

// sessionMethodOn: a session dies when the method it was made with is
// switched off. "setup" sessions (the first admin) always count.
func sessionMethodOn(eff config.Effective, m string) bool {
	if m == methodSetup {
		return true
	}
	return eff.MethodOn(m)
}

// authenticate returns the caller (login disabled → anonymous admin; a
// trusted header; or the session cookie) or a failure code. API tokens are
// handled by the Jackett routes only. Valid sessions past half their
// lifetime are renewed (sliding).
func (s *Server) authenticate(w http.ResponseWriter, r *http.Request, re *reqEnv) (*principal, string) {
	eff := re.eff
	if eff.Disabled.Value {
		return &principal{role: store.RoleAdmin, via: viaDisabled}, ""
	}
	if eff.HeaderLogin() {
		h := auth.Header{Name: eff.HeaderName.Value, Trusted: eff.HeaderPrefixes}
		if v, ok := h.User(r); ok {
			u, fail := s.headerUser(re, v)
			if fail != "" {
				return nil, fail
			}
			return &principal{user: u, role: u.Role, via: viaHeader}, ""
		}
	}
	if pr := s.sessionPrincipal(w, r, re); pr != nil {
		return pr, ""
	}
	if eff.SetupRequired() {
		return nil, failSetupRequired
	}
	return nil, failUnauthorized
}

// sessionPrincipal checks the session cookie against the current state.
func (s *Server) sessionPrincipal(w http.ResponseWriter, r *http.Request, re *reqEnv) *principal {
	c, err := r.Cookie(session.CookieName)
	if err != nil || c.Value == "" {
		return nil
	}
	sess, ok := s.sessions.Decode(c.Value)
	if !ok || sess.Global != re.st.AuthEpoch || !sessionMethodOn(re.eff, sess.Method) {
		return nil
	}
	u := re.st.User(sess.UID)
	if u == nil || u.Disabled || u.Epoch != sess.Epoch {
		return nil
	}
	ttl := re.eff.SessionTTL.Value
	if w != nil && s.sessions.NeedsRenewal(sess, ttl) {
		sess = s.sessions.New(sess.UID, sess.Method, sess.Epoch, sess.Global, ttl)
		http.SetCookie(w, s.sessions.Cookie(sess, re.rv.Secure(r)))
	}
	return &principal{user: u, role: u.Role, via: viaSession, sess: sess}
}

// issueSession sets a fresh session cookie for u (with the current epochs).
func (s *Server) issueSession(w http.ResponseWriter, r *http.Request, re *reqEnv, u *store.User, method string) {
	global := s.store.Get().AuthEpoch
	sess := s.sessions.New(u.ID, method, u.Epoch, global, re.eff.SessionTTL.Value)
	http.SetCookie(w, s.sessions.Cookie(sess, re.rv.Secure(r)))
}

func (s *Server) clearSession(w http.ResponseWriter, r *http.Request, re *reqEnv) {
	http.SetCookie(w, session.ClearCookie(re.rv.Secure(r)))
}

// loginSucceeded records the login time and issues the session.
func (s *Server) loginSucceeded(w http.ResponseWriter, r *http.Request, re *reqEnv, uid, method string) error {
	var u store.User
	err := s.store.Update(func(st *store.Settings) error {
		p := st.User(uid)
		if p == nil {
			return &apiError{Status: http.StatusUnauthorized, Code: failUnauthorized, Message: "Пользователь удалён"}
		}
		now := s.now().UTC().Truncate(time.Second)
		p.LastLoginAt = &now
		u = *p
		return nil
	})
	if err != nil {
		return err
	}
	s.issueSession(w, r, re, &u, method)
	s.log.Info("login ok", "ip", re.rv.ClientIP(r).String(), "user", u.Username, "method", method)
	return nil
}

// ---- trusted header ----

const headerProvider = "header"

// headerUser maps a trusted header value to a user: by user name, or by a
// linked "header" identity (for values that are not valid user names, e.g.
// e-mails). Unknown values get an account when there are no users yet
// (first admin) or auto-provisioning is on (default role).
func (s *Server) headerUser(re *reqEnv, value string) (*store.User, string) {
	subject := strings.ToLower(value)
	find := func(st *store.Settings) *store.User {
		if u := users.ByUsername(st, value); u != nil {
			return u
		}
		return users.ByIdentity(st, headerProvider, "", subject)
	}
	if u := find(&re.st); u != nil {
		if u.Disabled {
			return nil, failUserDisabled
		}
		return u, ""
	}
	var created store.User
	fail := ""
	err := s.store.Update(func(st *store.Settings) error {
		if u := find(st); u != nil {
			created = *u
			return errNoChange
		}
		eff, err := config.Resolve(s.env, *st)
		if err != nil {
			return err
		}
		role := eff.DefaultRole.Value
		switch {
		case len(st.Users) == 0:
			role = store.RoleAdmin
		case !eff.AutoProvision.Value:
			fail = failNotAllowed
			return errNoChange
		}
		name := users.NormalizeUsername(value)
		if !users.ValidUsername(name) || users.ByUsername(st, name) != nil {
			name = users.DeriveUsername(value, users.UsernameTaken(st))
		}
		u := newUser(name, clipName(value), role, "", s.now())
		u.Identities = append(u.Identities, store.Identity{Provider: headerProvider, Subject: subject, Label: clipName(value), LinkedAt: u.CreatedAt})
		st.Users = append(st.Users, u)
		created = u
		s.log.Warn("user created from trusted header", "user", u.Username, "role", role)
		return nil
	})
	if fail != "" {
		return nil, fail
	}
	if err != nil && err != errNoChange {
		s.log.Error("header login: saving user failed", "error", err)
		return nil, failUnauthorized
	}
	if created.Disabled {
		return nil, failUserDisabled
	}
	return &created, ""
}

// errNoChange aborts a store.Update without writing.
var errNoChange = &apiError{Status: http.StatusOK, Code: "no_change"}

func clipName(s string) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > users.MaxNameLen {
		r = r[:users.MaxNameLen]
	}
	out := strings.Map(func(c rune) rune {
		if c < 0x20 || c == 0x7f {
			return -1
		}
		return c
	}, string(r))
	return out
}

// ---- external identities ----

// extIdentity is a finished external login (no allow-list applied yet).
type extIdentity struct {
	Provider, Issuer, Subject string
	Email                     string
	// EmailUsable: verified (or acceptable per the provider's settings).
	EmailUsable  bool
	Login        string // github login
	Groups       []string
	Name, Label  string
	UsernameHint string
}

// allowedBy applies the allow-lists: admin e-mails (→ admin), allowed
// e-mails, GitHub users, OIDC groups. code is user_not_allowed or
// email_not_verified when refused.
func allowedBy(eff config.Effective, id extIdentity) (ok, admin bool, code string) {
	if id.EmailUsable {
		if containsFold(eff.AdminEmails.Value, id.Email) {
			return true, true, ""
		}
		if containsFold(eff.AllowedEmails.Value, id.Email) {
			return true, false, ""
		}
	}
	if id.Provider == config.ProviderGitHub && containsFold(eff.GitHubUsers.Value, id.Login) {
		return true, false, ""
	}
	if id.Provider == config.ProviderOIDC {
		for _, g := range id.Groups {
			if containsFold(eff.Providers[config.ProviderOIDC].Groups.Value, g) {
				return true, false, ""
			}
		}
	}
	if id.Email != "" && !id.EmailUsable &&
		(containsFold(eff.AdminEmails.Value, id.Email) || containsFold(eff.AllowedEmails.Value, id.Email)) {
		return false, false, "email_not_verified"
	}
	return false, false, failNotAllowed
}

func containsFold(list []string, v string) bool {
	v = strings.TrimSpace(v)
	if v == "" {
		return false
	}
	for _, x := range list {
		if strings.EqualFold(strings.TrimSpace(x), v) {
			return true
		}
	}
	return false
}

func identityOf(id extIdentity, now time.Time) store.Identity {
	return store.Identity{Provider: id.Provider, Issuer: id.Issuer, Subject: id.Subject, Label: clipName(id.Label), LinkedAt: now.UTC().Truncate(time.Second)}
}

// resolveExternal maps an external login to a user (spec §3): a linked
// identity; else (no users yet, or auto-provisioning) a new account if the
// allow-lists admit it; else a refusal code.
func (s *Server) resolveExternal(id extIdentity) (store.User, string) {
	var out store.User
	fail := ""
	err := s.store.Update(func(st *store.Settings) error {
		if u := users.ByIdentity(st, id.Provider, id.Issuer, id.Subject); u != nil {
			if u.Disabled {
				fail = failUserDisabled
				return errNoChange
			}
			out = *u
			return errNoChange
		}
		eff, err := config.Resolve(s.env, *st)
		if err != nil {
			return err
		}
		ok, admin, code := allowedBy(eff, id)
		if !ok {
			fail = code
			return errNoChange
		}
		role := eff.DefaultRole.Value
		switch {
		case len(st.Users) == 0:
			role = store.RoleAdmin // bootstrap: the first allowed login
		case !eff.AutoProvision.Value:
			fail = failNotAllowed
			return errNoChange
		case admin:
			role = store.RoleAdmin
		}
		name := id.Name
		if name == "" {
			name = id.Label
		}
		u := newUser(users.DeriveUsername(id.UsernameHint, users.UsernameTaken(st)), clipName(name), role, "", s.now())
		u.Identities = append(u.Identities, identityOf(id, s.now()))
		st.Users = append(st.Users, u)
		out = u
		s.log.Warn("user created from external login", "user", u.Username, "provider", id.Provider, "role", role)
		return nil
	})
	if fail != "" {
		return store.User{}, fail
	}
	if err != nil && err != errNoChange {
		s.log.Error("external login: saving user failed", "error", err)
		return store.User{}, "internal"
	}
	return out, ""
}

// ---- lock-out rules ----

// canLogIn reports whether u still has a way to log in under eff:
// a password with the password method on, a linked identity whose provider
// is on and ready, or the trusted header (headerOK).
func canLogIn(eff config.Effective, envAdminPW bool, u *store.User, headerOK bool) bool {
	if eff.Disabled.Value {
		return true
	}
	if eff.MethodOn("password") && (u.PasswordHash != "" || (envAdminPW && u.Username == store.AdminUsername)) {
		return true
	}
	for _, id := range u.Identities {
		if config.ValidProvider(id.Provider) && eff.MethodOn(id.Provider) && eff.ProviderReady(id.Provider) {
			return true
		}
	}
	return headerOK && eff.HeaderLogin()
}

// adminsLockedOut reports whether no enabled admin could log in under eff.
// Header login counts only for an admin that the current request's trusted
// header maps to (proof that the proxy works).
func (s *Server) adminsLockedOut(eff config.Effective, st *store.Settings, r *http.Request) bool {
	if eff.Disabled.Value || len(st.Users) == 0 {
		return false
	}
	var headerValue string
	if eff.HeaderLogin() {
		h := auth.Header{Name: eff.HeaderName.Value, Trusted: eff.HeaderPrefixes}
		headerValue, _ = h.User(r)
	}
	for i := range st.Users {
		u := &st.Users[i]
		if u.Disabled || u.Role != store.RoleAdmin {
			continue
		}
		headerOK := headerValue != "" && (u.Username == users.NormalizeUsername(headerValue) ||
			slices.ContainsFunc(u.Identities, func(id store.Identity) bool {
				return id.Provider == headerProvider && id.Subject == strings.ToLower(headerValue)
			}))
		if canLogIn(eff, eff.AdminPassword.Value != "", u, headerOK) {
			return false
		}
	}
	return true
}

func errWouldLockOut(msg string) error {
	return &apiError{Status: http.StatusConflict, Code: "would_lock_out", Message: msg}
}

var errLastAdmin = &apiError{Status: http.StatusConflict, Code: "last_admin", Message: "Нельзя убрать последнего администратора"}

// ---- token usage (write-behind) ----

type usageEntry struct {
	at, persisted time.Time
	ip            string
	dirty         bool
}

type tokenUsage struct {
	mu sync.Mutex
	m  map[string]*usageEntry
}

func newTokenUsage() *tokenUsage { return &tokenUsage{m: map[string]*usageEntry{}} }

// usagePersistEvery: lastUsedAt is written at most this often per token.
const usagePersistEvery = time.Minute

// recordUsage notes a token use; the store is written at most once per
// minute per token (synchronously, by the request that crosses the minute).
func (s *Server) recordUsage(tokenID, ip string) {
	now := s.now().UTC().Truncate(time.Second)
	s.usage.mu.Lock()
	e := s.usage.m[tokenID]
	if e == nil {
		e = &usageEntry{}
		s.usage.m[tokenID] = e
	}
	e.at, e.ip, e.dirty = now, ip, true
	due := now.Sub(e.persisted) >= usagePersistEvery
	s.usage.mu.Unlock()
	if due {
		s.flushUsage(false)
	}
}

// flushUsage writes the pending usage (all = also entries written less than
// a minute ago).
func (s *Server) flushUsage(all bool) {
	now := s.now()
	type pending struct {
		at time.Time
		ip string
	}
	todo := map[string]pending{}
	s.usage.mu.Lock()
	for id, e := range s.usage.m {
		if e.dirty && (all || now.Sub(e.persisted) >= usagePersistEvery) {
			todo[id] = pending{e.at, e.ip}
			e.dirty, e.persisted = false, now
		}
	}
	s.usage.mu.Unlock()
	if len(todo) == 0 {
		return
	}
	err := s.store.Update(func(st *store.Settings) error {
		for i := range st.Tokens {
			if p, ok := todo[st.Tokens[i].ID]; ok {
				at := p.at
				st.Tokens[i].LastUsedAt, st.Tokens[i].LastUsedIP = &at, p.ip
			}
		}
		return nil
	})
	if err != nil {
		s.log.Warn("saving token usage failed", "error", err)
	}
}

// liveUsage overlays not-yet-written usage on t.
func (s *Server) liveUsage(t *store.Token) {
	s.usage.mu.Lock()
	defer s.usage.mu.Unlock()
	if e := s.usage.m[t.ID]; e != nil && e.dirty && (t.LastUsedAt == nil || e.at.After(*t.LastUsedAt)) {
		at := e.at
		t.LastUsedAt, t.LastUsedIP = &at, e.ip
	}
}
