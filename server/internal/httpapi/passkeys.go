package httpapi

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/bropines/jackett-ui/server/internal/config"
	"github.com/bropines/jackett-ui/server/internal/store"
)

// Passkeys (WebAuthn), see docs/spec-v0.4-auth.md §4.

const (
	ceremonyTTL         = 5 * time.Minute
	maxLoginCeremonies  = 500
	maxPasskeysPerUser  = 20
	maxPasskeyNameRunes = 64
	defaultPasskeyName  = "Passkey"
	passkeyMethod       = "passkey"
)

const passkeyUnavailable = "Passkey работает только по https-адресу с доменным именем (PUBLIC_URL)"

// passkeyRP returns the relying party id for origin, or why passkeys can't
// work there: WebAuthn needs a secure context and a domain name.
func passkeyRP(origin string) (rpID, reason string) {
	u, err := url.Parse(origin)
	if err != nil || u.Hostname() == "" {
		return "", passkeyUnavailable
	}
	host := strings.ToLower(u.Hostname())
	if net.ParseIP(host) != nil {
		return "", passkeyUnavailable
	}
	local := host == "localhost" || strings.HasSuffix(host, ".localhost")
	if u.Scheme != "https" && !local {
		return "", passkeyUnavailable
	}
	return host, ""
}

// webAuthnFor builds the relying party for this request's origin.
func webAuthnFor(r *http.Request, re *reqEnv) (*webauthn.WebAuthn, string, error) {
	origin := re.rv.Origin(r)
	rpID, reason := passkeyRP(origin)
	if reason != "" {
		return nil, "", &apiError{Status: http.StatusConflict, Code: "passkeys_unavailable", Message: reason}
	}
	wa, err := webauthn.New(&webauthn.Config{
		RPID:          rpID,
		RPDisplayName: "Jackett",
		RPOrigins:     []string{origin},
	})
	if err != nil {
		return nil, "", err
	}
	return wa, origin, nil
}

// ---- WebAuthn user adapter ----

type waUser struct{ u *store.User }

func (w waUser) WebAuthnID() []byte   { return w.u.WebAuthnID }
func (w waUser) WebAuthnName() string { return w.u.Username }
func (w waUser) WebAuthnDisplayName() string {
	if w.u.Name != "" {
		return w.u.Name
	}
	return w.u.Username
}

func (w waUser) WebAuthnCredentials() []webauthn.Credential {
	out := make([]webauthn.Credential, 0, len(w.u.Passkeys))
	for _, p := range w.u.Passkeys {
		out = append(out, credentialOf(&p))
	}
	return out
}

func credentialOf(p *store.Passkey) webauthn.Credential {
	tr := make([]protocol.AuthenticatorTransport, 0, len(p.Transports))
	for _, t := range p.Transports {
		tr = append(tr, protocol.AuthenticatorTransport(t))
	}
	return webauthn.Credential{
		ID:              p.CredentialID,
		PublicKey:       p.PublicKey,
		AttestationType: p.AttestationType,
		Transport:       tr,
		Flags: webauthn.CredentialFlags{
			UserPresent: true, UserVerified: true,
			BackupEligible: p.BackupEligible, BackupState: p.BackupState,
		},
		Authenticator: webauthn.Authenticator{
			AAGUID: p.AAGUID, SignCount: p.SignCount, CloneWarning: p.CloneWarning,
			Attachment: protocol.AuthenticatorAttachment(p.Attachment),
		},
	}
}

func passkeyOf(c *webauthn.Credential, name string, now time.Time) store.Passkey {
	tr := make([]string, 0, len(c.Transport))
	for _, t := range c.Transport {
		tr = append(tr, string(t))
	}
	return store.Passkey{
		ID: store.NewID("pk_"), Name: name,
		CredentialID: c.ID, PublicKey: c.PublicKey, AttestationType: c.AttestationType,
		AAGUID: c.Authenticator.AAGUID, SignCount: c.Authenticator.SignCount,
		Transports: tr, Attachment: string(c.Authenticator.Attachment),
		BackupEligible: c.Flags.BackupEligible, BackupState: c.Flags.BackupState,
		CreatedAt: now.UTC().Truncate(time.Second),
	}
}

// ---- ceremonies (in memory, single use) ----

type ceremony struct {
	login   bool
	uid     string // registration: the user and its epoch
	epoch   uint64
	handle  []byte // registration: the user handle to store
	origin  string
	data    webauthn.SessionData
	expires time.Time
}

type ceremonies struct {
	mu sync.Mutex
	m  map[string]*ceremony
}

func newCeremonies() *ceremonies { return &ceremonies{m: map[string]*ceremony{}} }

var errTooManyCeremonies = &apiError{Status: http.StatusTooManyRequests, Code: "rate_limited", Message: "Слишком много попыток, подождите"}

// put stores c and returns its id.
func (cs *ceremonies) put(c *ceremony, now time.Time) (string, error) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	logins := 0
	for id, x := range cs.m {
		if now.After(x.expires) {
			delete(cs.m, id)
		} else if x.login {
			logins++
		}
	}
	if c.login && logins >= maxLoginCeremonies {
		return "", errTooManyCeremonies
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	id := base64.RawURLEncoding.EncodeToString(b)
	c.expires = now.Add(ceremonyTTL)
	cs.m[id] = c
	return id, nil
}

// take removes and returns the ceremony id (nil if unknown or expired).
func (cs *ceremonies) take(id string, now time.Time) *ceremony {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	c := cs.m[id]
	delete(cs.m, id)
	if c == nil || now.After(c.expires) {
		return nil
	}
	return c
}

// ---- views ----

type passkeyView struct {
	ID           string     `json:"id"`
	Name         string     `json:"name"`
	CreatedAt    time.Time  `json:"createdAt"`
	LastUsedAt   *time.Time `json:"lastUsedAt"`
	Synced       bool       `json:"synced"`
	CloneWarning bool       `json:"cloneWarning"`
}

func passkeyViewOf(p *store.Passkey) passkeyView {
	return passkeyView{ID: p.ID, Name: p.Name, CreatedAt: p.CreatedAt, LastUsedAt: p.LastUsedAt, Synced: p.BackupState, CloneWarning: p.CloneWarning}
}

type ceremonyResponse struct {
	Ceremony  string `json:"ceremony"`
	PublicKey any    `json:"publicKey"`
}

// passkeyLoginOffered: the login page shows the passkey button.
func passkeyLoginOffered(eff config.Effective, st *store.Settings, origin string) bool {
	if !eff.MethodOn(passkeyMethod) {
		return false
	}
	if _, reason := passkeyRP(origin); reason != "" {
		return false
	}
	for i := range st.Users {
		if !st.Users[i].Disabled && len(st.Users[i].Passkeys) > 0 {
			return true
		}
	}
	return false
}

func passkeyNameArg(v string) (string, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return defaultPasskeyName, nil
	}
	if utf8.RuneCountInString(v) > maxPasskeyNameRunes || !utf8.ValidString(v) || strings.ContainsFunc(v, func(c rune) bool { return c < 0x20 || c == 0x7f }) {
		return "", badField("name", "Название: до 64 символов")
	}
	return v, nil
}

// ---- login ----

var errPasskeyInvalid = &apiError{Status: http.StatusUnauthorized, Code: "passkey_invalid", Message: "Passkey не подошёл"}

func (s *Server) handlePasskeyLoginBegin(w http.ResponseWriter, r *http.Request, re *reqEnv) {
	if !re.eff.MethodOn(passkeyMethod) {
		writeErr(w, http.StatusForbidden, "passkey_login_disabled", "Вход по passkey отключён")
		return
	}
	wa, origin, err := webAuthnFor(r, re)
	if err != nil {
		writeErr(w, http.StatusForbidden, "passkey_login_disabled", passkeyUnavailable)
		return
	}
	assertion, data, err := wa.BeginDiscoverableLogin(webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		writeAPIError(w, err)
		return
	}
	id, err := s.ceremonies.put(&ceremony{login: true, origin: origin, data: *data}, s.now())
	if err != nil {
		writeAPIError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ceremonyResponse{Ceremony: id, PublicKey: assertion.Response})
}

type passkeyFinishBody struct {
	Ceremony   string          `json:"ceremony"`
	Name       string          `json:"name"`
	Credential json.RawMessage `json:"credential"`
}

func (s *Server) handlePasskeyLoginFinish(w http.ResponseWriter, r *http.Request, re *reqEnv) {
	if !re.eff.MethodOn(passkeyMethod) {
		writeErr(w, http.StatusForbidden, "passkey_login_disabled", "Вход по passkey отключён")
		return
	}
	if !s.rateLimit(w, r, re) {
		return
	}
	var body passkeyFinishBody
	if err := decodeJSON(w, r, &body); err != nil {
		writeAPIError(w, err)
		return
	}
	ip := re.rv.ClientIP(r)
	fail := func(why string) {
		s.limiter.Failure(ip)
		s.log.Warn("login failed", "ip", ip.String(), "method", passkeyMethod, "reason", why)
		writeAPIError(w, errPasskeyInvalid)
	}
	c := s.ceremonies.take(body.Ceremony, s.now())
	if c == nil || !c.login {
		fail("unknown or expired ceremony")
		return
	}
	wa, origin, err := webAuthnFor(r, re)
	if err != nil || subtle.ConstantTimeCompare([]byte(origin), []byte(c.origin)) != 1 {
		fail("origin changed")
		return
	}
	parsed, err := protocol.ParseCredentialRequestResponseBody(bytes.NewReader(body.Credential))
	if err != nil {
		fail("bad credential")
		return
	}
	var uid string
	handler := func(rawID, userHandle []byte) (webauthn.User, error) {
		for i := range re.st.Users {
			u := &re.st.Users[i]
			if len(u.WebAuthnID) == 0 || !bytes.Equal(u.WebAuthnID, userHandle) {
				continue
			}
			for _, p := range u.Passkeys {
				if bytes.Equal(p.CredentialID, rawID) {
					uid = u.ID
					return waUser{u}, nil
				}
			}
		}
		return nil, errPasskeyInvalid
	}
	_, cred, err := wa.ValidatePasskeyLogin(handler, c.data, parsed)
	if err != nil || uid == "" {
		fail("verification failed")
		return
	}
	clone := cred.Authenticator.CloneWarning
	var disabled bool
	err = s.store.Update(func(st *store.Settings) error {
		u := st.User(uid)
		if u == nil {
			return errPasskeyInvalid
		}
		disabled = u.Disabled
		for i := range u.Passkeys {
			p := &u.Passkeys[i]
			if !bytes.Equal(p.CredentialID, cred.ID) {
				continue
			}
			if clone {
				p.CloneWarning = true
				return nil
			}
			now := s.now().UTC().Truncate(time.Second)
			p.SignCount, p.BackupState, p.LastUsedAt = cred.Authenticator.SignCount, cred.Flags.BackupState, &now
			return nil
		}
		return errPasskeyInvalid
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if clone {
		fail("sign counter went back (cloned authenticator?)")
		return
	}
	s.limiter.Success(ip)
	if disabled {
		writeAuthFail(w, failUserDisabled)
		return
	}
	if err := s.loginSucceeded(w, r, re, uid, passkeyMethod); err != nil {
		writeAPIError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- my passkeys ----

// passkeyOwner: registering and removing passkeys needs a real session.
func passkeyOwner(pr *principal) error {
	if pr.user == nil {
		return errNoUser
	}
	if pr.via != viaSession {
		return &apiError{Status: http.StatusConflict, Code: "session_required", Message: "Войдите в панель через браузер, чтобы управлять passkey"}
	}
	return nil
}

func (s *Server) handleMyPasskeys(w http.ResponseWriter, re *reqEnv, pr *principal) {
	if pr.user == nil {
		writeAPIError(w, errNoUser)
		return
	}
	u := re.st.User(pr.user.ID)
	out := []passkeyView{}
	for i := range u.Passkeys {
		out = append(out, passkeyViewOf(&u.Passkeys[i]))
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handlePasskeyRegisterBegin(w http.ResponseWriter, r *http.Request, re *reqEnv, pr *principal) {
	if err := passkeyOwner(pr); err != nil {
		writeAPIError(w, err)
		return
	}
	u := *re.st.User(pr.user.ID)
	if len(u.Passkeys) >= maxPasskeysPerUser {
		writeAPIError(w, conflict("too_many_passkeys", "Не больше 20 passkey на пользователя"))
		return
	}
	wa, origin, err := webAuthnFor(r, re)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if len(u.WebAuthnID) == 0 {
		u.WebAuthnID = make([]byte, 32)
		if _, err := rand.Read(u.WebAuthnID); err != nil {
			writeAPIError(w, err)
			return
		}
	}
	exclude := make([]protocol.CredentialDescriptor, 0, len(u.Passkeys))
	for _, c := range (waUser{&u}).WebAuthnCredentials() {
		exclude = append(exclude, c.Descriptor())
	}
	required := true
	creation, data, err := wa.BeginRegistration(waUser{&u},
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			RequireResidentKey: &required,
			ResidentKey:        protocol.ResidentKeyRequirementRequired,
			UserVerification:   protocol.VerificationRequired,
		}),
		webauthn.WithExclusions(exclude),
	)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	id, err := s.ceremonies.put(&ceremony{uid: u.ID, epoch: u.Epoch, handle: u.WebAuthnID, origin: origin, data: *data}, s.now())
	if err != nil {
		writeAPIError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ceremonyResponse{Ceremony: id, PublicKey: creation.Response})
}

var errCeremonyExpired = &apiError{Status: http.StatusBadRequest, Code: "ceremony_expired", Message: "Время на добавление passkey вышло, попробуйте ещё раз"}

func (s *Server) handlePasskeyRegisterFinish(w http.ResponseWriter, r *http.Request, re *reqEnv, pr *principal) {
	if err := passkeyOwner(pr); err != nil {
		writeAPIError(w, err)
		return
	}
	var body passkeyFinishBody
	if err := decodeJSON(w, r, &body); err != nil {
		writeAPIError(w, err)
		return
	}
	name, err := passkeyNameArg(body.Name)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	c := s.ceremonies.take(body.Ceremony, s.now())
	if c == nil || c.login || c.uid != pr.user.ID || c.epoch != pr.user.Epoch {
		writeAPIError(w, errCeremonyExpired)
		return
	}
	wa, origin, err := webAuthnFor(r, re)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if origin != c.origin {
		writeAPIError(w, errCeremonyExpired)
		return
	}
	parsed, err := protocol.ParseCredentialCreationResponseBody(bytes.NewReader(body.Credential))
	if err != nil {
		writeAPIError(w, badField("credential", "Браузер вернул некорректный ответ"))
		return
	}
	u := *re.st.User(pr.user.ID)
	u.WebAuthnID = c.handle
	cred, err := wa.CreateCredential(waUser{&u}, c.data, parsed)
	if err != nil {
		s.log.Warn("passkey registration failed", "user", u.Username, "error", err)
		writeAPIError(w, badField("credential", "Не удалось проверить passkey"))
		return
	}
	pk := passkeyOf(cred, name, s.now())
	err = s.store.Update(func(st *store.Settings) error {
		p := st.User(u.ID)
		if p == nil {
			return errUserNotFound
		}
		if len(p.Passkeys) >= maxPasskeysPerUser {
			return conflict("too_many_passkeys", "Не больше 20 passkey на пользователя")
		}
		for i := range st.Users {
			for _, x := range st.Users[i].Passkeys {
				if bytes.Equal(x.CredentialID, pk.CredentialID) {
					return conflict("passkey_exists", "Этот passkey уже добавлен")
				}
			}
		}
		if len(p.WebAuthnID) == 0 {
			p.WebAuthnID = c.handle
		}
		p.Passkeys = append(p.Passkeys, pk)
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	s.log.Info("passkey added", "user", u.Username, "ip", re.rv.ClientIP(r).String())
	writeJSON(w, http.StatusCreated, passkeyViewOf(&pk))
}

var errPasskeyNotFound = &apiError{Status: http.StatusNotFound, Code: "passkey_not_found", Message: "Passkey не найден"}

func (s *Server) handlePasskeyRename(w http.ResponseWriter, r *http.Request, pr *principal, pid string) {
	if pr.user == nil {
		writeAPIError(w, errNoUser)
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeAPIError(w, err)
		return
	}
	name, err := passkeyNameArg(body.Name)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	var out store.Passkey
	err = s.store.Update(func(st *store.Settings) error {
		u := st.User(pr.user.ID)
		if u == nil {
			return errUserNotFound
		}
		for i := range u.Passkeys {
			if u.Passkeys[i].ID == pid {
				u.Passkeys[i].Name = name
				out = u.Passkeys[i]
				return nil
			}
		}
		return errPasskeyNotFound
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, passkeyViewOf(&out))
}

// handlePasskeyDelete removes passkey pid of user uid. Removing your own
// passkey must leave you a way to log in.
func (s *Server) handlePasskeyDelete(w http.ResponseWriter, pr *principal, uid, pid string) {
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
		for i := range u.Passkeys {
			if u.Passkeys[i].ID == pid {
				idx = i
			}
		}
		if idx < 0 {
			return errPasskeyNotFound
		}
		u.Passkeys = append(u.Passkeys[:idx], u.Passkeys[idx+1:]...)
		if uid == pr.uid() {
			eff, err := config.Resolve(s.env, *st)
			if err != nil {
				return err
			}
			if !canLogIn(eff, eff.AdminPassword.Value != "", u, true) {
				return errWouldLockOut("Без этого passkey вам будет нечем войти: задайте пароль или добавьте другой способ входа")
			}
		}
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	s.log.Info("passkey removed", "user", uid, "by", pr.name())
	w.WriteHeader(http.StatusNoContent)
}
