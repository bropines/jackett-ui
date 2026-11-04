package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"html/template"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/bropines/jackett-ui/server/internal/auth/github"
	"github.com/bropines/jackett-ui/server/internal/auth/oidc"
	"github.com/bropines/jackett-ui/server/internal/config"
	"github.com/bropines/jackett-ui/server/internal/store"
	"github.com/bropines/jackett-ui/server/internal/users"
)

// extProvider is a configured external login provider. Adding a provider
// kind = a providerFactory plus an adapter implementing this.
type extProvider interface {
	start(w http.ResponseWriter, r *http.Request, s oidc.Signer, returnPath, intent string, secure bool) (string, error)
	finish(w http.ResponseWriter, r *http.Request, s oidc.Signer, secure bool) (extResult, error)
}

// extResult is a finished external login: the identity (allow-lists not
// applied: that depends on what the login is for), the return path and the
// flow's intent.
type extResult struct {
	Identity   extIdentity
	ReturnPath string
	Intent     string
}

// providerFactory builds an extProvider for the effective provider config
// and the redirect URL. It may do network I/O (OIDC discovery).
type providerFactory func(ctx context.Context, p config.Provider, eff config.Effective, redirect string) (extProvider, error)

// ---- oidc / google ----

type oidcAdapter struct {
	p               *oidc.Provider
	id              string
	allowUnverified bool
}

func (a oidcAdapter) start(w http.ResponseWriter, r *http.Request, s oidc.Signer, rp, intent string, secure bool) (string, error) {
	return a.p.Start(w, r, s, rp, intent, secure)
}

func (a oidcAdapter) finish(w http.ResponseWriter, r *http.Request, s oidc.Signer, secure bool) (extResult, error) {
	// The oidc package gets no allow-lists (= admits every user of the IdP):
	// httpapi decides per intent (linked identity, auto-provisioning, invite).
	res, err := a.p.Finish(w, r, s, secure)
	if err != nil {
		return extResult{}, err
	}
	id := res.Identity
	label := id.Email
	if label == "" {
		label = id.PreferredUsername
	}
	if label == "" {
		label = id.Subject
	}
	hint := id.Email
	if hint == "" {
		hint = id.PreferredUsername
	}
	if hint == "" {
		hint = "user"
	}
	return extResult{
		Identity: extIdentity{
			Provider: a.id, Issuer: id.Issuer, Subject: id.Subject,
			Email: strings.ToLower(id.Email), EmailUsable: id.EmailUsable(a.allowUnverified),
			Groups: id.Groups, Name: id.Name, Label: label, UsernameHint: hint,
		},
		ReturnPath: res.ReturnPath, Intent: res.TestToken,
	}, nil
}

func (s *Server) oidcFactory(ctx context.Context, p config.Provider, _ config.Effective, redirect string) (extProvider, error) {
	cfg := oidc.Config{
		Issuer:       p.Issuer.Value,
		ClientID:     p.ClientID.Value,
		ClientSecret: p.ClientSecret.Value,
		Scopes:       strings.Fields(p.Scopes.Value),
		RedirectURL:  redirect,
	}
	if p.ID == config.ProviderGoogle {
		cfg.Issuer = s.googleIssuer
	}
	if p.ID == config.ProviderOIDC {
		cfg.GroupsClaim = p.GroupsClaim.Value
	}
	op, err := oidc.New(ctx, cfg, s.httpClient)
	if err != nil {
		return nil, err
	}
	return oidcAdapter{p: op, id: p.ID, allowUnverified: p.ID == config.ProviderOIDC && p.AllowUnverifiedEmail.Value}, nil
}

// ---- github ----

type githubAdapter struct{ p *github.Provider }

func (a githubAdapter) start(w http.ResponseWriter, r *http.Request, s oidc.Signer, rp, intent string, secure bool) (string, error) {
	return a.p.Start(w, r, s, rp, intent, secure)
}

func (a githubAdapter) finish(w http.ResponseWriter, r *http.Request, s oidc.Signer, secure bool) (extResult, error) {
	res, err := a.p.Finish(w, r, s, secure)
	if err != nil {
		return extResult{}, err
	}
	id := res.Identity
	return extResult{
		Identity: extIdentity{
			Provider: config.ProviderGitHub, Issuer: github.Issuer, Subject: id.Subject(),
			// Email is only set when it is GitHub's primary verified address.
			Email: id.Email, EmailUsable: id.Email != "", Login: id.Login,
			Name: id.Name, Label: id.User(), UsernameHint: id.Login,
		},
		ReturnPath: res.ReturnPath, Intent: res.TestToken,
	}, nil
}

func (s *Server) githubFactory(_ context.Context, p config.Provider, _ config.Effective, redirect string) (extProvider, error) {
	gp, err := github.New(github.Config{
		ClientID:     p.ClientID.Value,
		ClientSecret: p.ClientSecret.Value,
		RedirectURL:  redirect,
		Endpoints:    s.githubEndpoints,
	}, s.httpClient)
	if err != nil {
		return nil, err
	}
	return githubAdapter{p: gp}, nil
}

// ---- provider cache ----

// provRetry: after a failed build (e.g. discovery), wait this long before
// trying again, so public login clicks can't hammer the IdP.
const provRetry = 30 * time.Second

type provEntry struct {
	prov extProvider
	err  error
	at   time.Time
}

func providerKey(p config.Provider, redirect string) string {
	h := sha256.New()
	for _, v := range []string{p.ID, p.Hash(), redirect, p.GroupsClaim.Value, strconv.FormatBool(p.AllowUnverifiedEmail.Value)} {
		h.Write([]byte(v))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

// redirectURL is <origin>/_ui/auth/{id}/callback.
func redirectURL(origin, id string) string {
	return origin + "/_ui/auth/" + id + "/callback"
}

// provider returns the (cached) login provider id for the current settings.
func (s *Server) provider(ctx context.Context, re *reqEnv, r *http.Request, id string) (extProvider, error) {
	p := re.eff.Providers[id]
	if !p.Enabled() {
		return nil, oidc.ErrNotConfigured
	}
	redirect := redirectURL(re.rv.Origin(r), id)
	key := providerKey(p, redirect)
	s.provMu.Lock()
	if e, ok := s.provCache[key]; ok && (e.err == nil || s.now().Sub(e.at) < provRetry) {
		s.provMu.Unlock()
		return e.prov, e.err
	}
	s.provMu.Unlock()

	bctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	prov, err := s.factories[id](bctx, p, re.eff, redirect)
	cancel()
	if err != nil {
		s.log.Warn("login provider unavailable", "provider", id, "error", err)
	}
	s.provMu.Lock()
	if len(s.provCache) >= 16 {
		clear(s.provCache)
	}
	s.provCache[key] = &provEntry{prov: prov, err: err, at: s.now()}
	s.provMu.Unlock()
	return prov, err
}

// ---- start / callback ----

// Flow intents (carried, signed, in the flow cookie's test-token field).
const (
	intentTest   = "test:"
	intentLink   = "link:"
	intentInvite = "invite:"
)

// redirectWith appends k=v to the (sanitized) path.
func redirectWith(w http.ResponseWriter, r *http.Request, p, k, v string) {
	p = oidc.SanitizeReturnPath(p)
	sep := "?"
	if strings.Contains(p, "?") {
		sep = "&"
	}
	http.Redirect(w, r, p+sep+k+"="+url.QueryEscape(v), http.StatusFound)
}

func authErrorRedirect(w http.ResponseWriter, r *http.Request, code string) {
	redirectWith(w, r, "/", "authError", code)
}

// errCode maps login errors to fixed codes. Never put err.Error() in a URL:
// it may contain IdP-provided text.
func errCode(err error) string {
	if errors.Is(err, oidc.ErrNotAllowed) && strings.Contains(err.Error(), "not verified") {
		return "email_not_verified"
	}
	for _, e := range []error{oidc.ErrState, oidc.ErrFlowExpired, oidc.ErrIdP, oidc.ErrExchange,
		oidc.ErrToken, oidc.ErrNonce, oidc.ErrNotAllowed, oidc.ErrNotConfigured} {
		if errors.Is(err, e) {
			return e.Error()
		}
	}
	return oidc.ErrIdP.Error()
}

func linkIntent(u *store.User, global uint64) string {
	return intentLink + u.ID + ":" + strconv.FormatUint(u.Epoch, 10) + ":" + strconv.FormatUint(global, 10)
}

func (s *Server) handleProviderStart(w http.ResponseWriter, r *http.Request, re *reqEnv, id string) {
	secure := re.rv.Secure(r)
	q := r.URL.Query()
	if tok := q.Get("test"); tok != "" {
		tf := s.tests.get(tok)
		if tf == nil || tf.provider != id {
			s.renderTestPage(w, false, "test_expired")
			return
		}
		u, err := tf.prov.start(w, r, s.flowSigner, "/", intentTest+tok, secure)
		if err != nil {
			s.tests.finish(tok, "", errCode(err))
			s.renderTestPage(w, false, errCode(err))
			return
		}
		http.Redirect(w, r, u, http.StatusFound)
		return
	}

	returnPath := oidc.SanitizeReturnPath(q.Get("return"))
	var intent string
	switch {
	case q.Get("link") != "":
		// Link to the logged-in user (session or header login only).
		if q.Get("return") == "" {
			returnPath = "/profile"
		}
		pr, fail := s.authenticate(w, r, re)
		if fail != "" || pr.user == nil {
			authErrorRedirect(w, r, failUnauthorized)
			return
		}
		if !re.eff.ProviderReady(id) {
			redirectWith(w, r, returnPath, "authError", "provider_disabled")
			return
		}
		intent = linkIntent(pr.user, re.st.AuthEpoch)
	case q.Get("invite") != "":
		secret := q.Get("invite")
		inv, err := s.inviteFor(&re.st, secret, "")
		if err != nil {
			code := "invite_not_found"
			if errors.Is(err, errInviteExpired) {
				code = "invite_expired"
			}
			authErrorRedirect(w, r, code)
			return
		}
		returnPath = "/invite/" + secret
		if !providerOffered(re.eff, id) {
			redirectWith(w, r, returnPath, "authError", "provider_disabled")
			return
		}
		intent = intentInvite + inv.Hash
	default:
		if !providerOffered(re.eff, id) {
			authErrorRedirect(w, r, "provider_disabled")
			return
		}
	}
	prov, err := s.provider(r.Context(), re, r, id)
	if err != nil {
		redirectWith(w, r, errorBase(intent, returnPath), "authError", "not_configured")
		return
	}
	u, err := prov.start(w, r, s.flowSigner, returnPath, intent, secure)
	if err != nil {
		s.log.Warn("login start failed", "provider", id, "error", err)
		redirectWith(w, r, errorBase(intent, returnPath), "authError", "not_configured")
		return
	}
	http.Redirect(w, r, u, http.StatusFound)
}

// errorBase: where errors of a flow go (the return path for link and
// invite flows, "/" for logins).
func errorBase(intent, returnPath string) string {
	if strings.HasPrefix(intent, intentLink) || strings.HasPrefix(intent, intentInvite) {
		return returnPath
	}
	return "/"
}

func providerOffered(eff config.Effective, id string) bool {
	for _, p := range eff.LoginProviders() {
		if p.ID == id {
			return true
		}
	}
	return false
}

func (s *Server) clearFlowCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{Name: oidc.FlowCookie, Value: "", Path: "/_ui/auth/", MaxAge: -1,
		Expires: time.Unix(0, 0), HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode})
}

func (s *Server) handleProviderCallback(w http.ResponseWriter, r *http.Request, re *reqEnv, id string) {
	secure := re.rv.Secure(r)
	ip := re.rv.ClientIP(r).String()

	intent, returnPath, _ := oidc.FlowInfo(r, s.flowSigner)
	if tok, ok := strings.CutPrefix(intent, intentTest); ok {
		s.finishTest(w, r, id, tok, secure)
		return
	}
	base := errorBase(intent, returnPath)
	fail := func(code string) {
		s.clearFlowCookie(w, secure)
		redirectWith(w, r, base, "authError", code)
	}

	switch {
	case strings.HasPrefix(intent, intentLink):
		if !re.eff.ProviderReady(id) {
			fail("provider_disabled")
			return
		}
	default: // login, invite
		if !providerOffered(re.eff, id) {
			fail("provider_disabled")
			return
		}
	}
	prov, err := s.provider(r.Context(), re, r, id)
	if err != nil {
		fail("not_configured")
		return
	}
	res, err := prov.finish(w, r, s.flowSigner, secure)
	if err == nil && res.Intent != intent {
		err = oidc.ErrState
	}
	if err != nil {
		s.log.Warn("external login failed", "ip", ip, "provider", id, "error", err)
		redirectWith(w, r, base, "authError", errCode(err))
		return
	}

	switch {
	case strings.HasPrefix(intent, intentLink):
		s.finishLink(w, r, re, id, strings.TrimPrefix(intent, intentLink), res)
	case strings.HasPrefix(intent, intentInvite):
		s.finishInvite(w, r, re, id, strings.TrimPrefix(intent, intentInvite), res)
	default:
		u, code := s.resolveExternal(res.Identity)
		if code != "" {
			s.log.Warn("external login refused", "ip", ip, "provider", id, "code", code, "identity", res.Identity.Label)
			authErrorRedirect(w, r, code)
			return
		}
		if err := s.loginSucceeded(w, r, re, u.ID, id); err != nil {
			authErrorRedirect(w, r, "internal")
			return
		}
		http.Redirect(w, r, oidc.SanitizeReturnPath(res.ReturnPath), http.StatusFound)
	}
}

// finishLink links the identity to the user that started the flow, which
// must still be the current session's user (same epochs).
func (s *Server) finishLink(w http.ResponseWriter, r *http.Request, re *reqEnv, id, want string, res extResult) {
	back := res.ReturnPath
	pr, failCode := s.authenticate(w, r, re)
	if failCode != "" || pr.user == nil || linkIntent(pr.user, re.st.AuthEpoch) != intentLink+want {
		redirectWith(w, r, back, "authError", "wrong_session")
		return
	}
	idn := res.Identity
	err := s.store.Update(func(st *store.Settings) error {
		if other := users.ByIdentity(st, idn.Provider, idn.Issuer, idn.Subject); other != nil {
			if other.ID == pr.user.ID {
				return errNoChange
			}
			return conflict("identity_in_use", "")
		}
		u := st.User(pr.user.ID)
		if u == nil {
			return errUserNotFound
		}
		for _, x := range u.Identities {
			if x.Provider == idn.Provider {
				return conflict("provider_already_linked", "")
			}
		}
		u.Identities = append(u.Identities, identityOf(idn, s.now()))
		return nil
	})
	if err != nil && err != errNoChange {
		var ae *apiError
		code := "internal"
		if errors.As(err, &ae) {
			code = ae.Code
		}
		s.log.Warn("link refused", "user", pr.name(), "provider", id, "code", code)
		redirectWith(w, r, back, "authError", code)
		return
	}
	s.log.Info("identity linked", "user", pr.name(), "provider", id, "identity", idn.Label)
	redirectWith(w, r, back, "linked", id)
}

// finishInvite creates the invited user with this identity (allow-lists are
// not required: the invite is the permission) and logs them in.
func (s *Server) finishInvite(w http.ResponseWriter, r *http.Request, re *reqEnv, id, hash string, res extResult) {
	back := res.ReturnPath
	idn := res.Identity
	var u store.User
	err := s.store.Update(func(st *store.Settings) error {
		inv, err := s.inviteFor(st, "", hash)
		if err != nil {
			return err
		}
		if users.ByIdentity(st, idn.Provider, idn.Issuer, idn.Subject) != nil {
			return conflict("identity_in_use", "")
		}
		name := inv.Name
		if name == "" {
			name = idn.Name
		}
		if name == "" {
			name = idn.Label
		}
		u = newUser(users.DeriveUsername(idn.UsernameHint, users.UsernameTaken(st)), clipName(name), inv.Role, "", s.now())
		u.Identities = append(u.Identities, identityOf(idn, s.now()))
		st.Users = append(st.Users, u)
		removeInvite(st, inv.ID)
		return nil
	})
	if err != nil {
		var ae *apiError
		code := "internal"
		if errors.As(err, &ae) {
			code = ae.Code
		}
		redirectWith(w, r, back, "authError", code)
		return
	}
	s.log.Warn("invite accepted", "user", u.Username, "role", u.Role, "provider", id)
	if err := s.loginSucceeded(w, r, re, u.ID, id); err != nil {
		authErrorRedirect(w, r, "internal")
		return
	}
	http.Redirect(w, r, "/", http.StatusFound)
}

// finishTest completes a settings "test login": on success it stores the
// tested settings' hash as verified. The caller's session is not changed.
// It proves the IdP round trip works; who may log in is decided per login.
func (s *Server) finishTest(w http.ResponseWriter, r *http.Request, id, tok string, secure bool) {
	tf := s.tests.get(tok)
	if tf == nil || tf.provider != id {
		s.clearFlowCookie(w, secure)
		s.renderTestPage(w, false, "test_expired")
		return
	}
	res, err := tf.prov.finish(w, r, s.flowSigner, secure)
	if err == nil && res.Intent != intentTest+tok {
		err = oidc.ErrState
	}
	if err != nil {
		s.log.Warn("test login failed", "provider", id, "error", err)
		s.tests.finish(tok, "", errCode(err))
		s.renderTestPage(w, false, errCode(err))
		return
	}
	err = s.store.Update(func(st *store.Settings) error {
		st.Auth.Providers.Get(id).VerifiedHash = tf.hash
		return nil
	})
	if err != nil {
		s.log.Error("saving verified provider failed", "provider", id, "error", err)
		s.tests.finish(tok, "", "internal")
		s.renderTestPage(w, false, "internal")
		return
	}
	s.log.Info("test login ok, provider settings verified", "provider", id, "user", res.Identity.Label)
	s.tests.finish(tok, res.Identity.Label, "")
	s.renderTestPage(w, true, "")
}

var testPage = template.Must(template.New("t").Parse(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Проверка входа</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}
.ok{color:#047857}.fail{color:#b91c1c}code{background:#8882;padding:0 .3em;border-radius:.2em}</style></head>
<body>{{if .OK}}<h1 class="ok">Проверка пройдена</h1><p>Настройки входа сохранены как проверенные. Можно закрыть вкладку.</p>
{{else}}<h1 class="fail">Проверка не пройдена</h1><p>Код ошибки: <code>{{.Code}}</code>. Проверьте настройки и попробуйте снова.</p>{{end}}
<p><a href="/settings">Вернуться к настройкам</a></p></body></html>`))

func (s *Server) renderTestPage(w http.ResponseWriter, ok bool, code string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	status := http.StatusOK
	if !ok {
		status = http.StatusBadRequest
	}
	w.WriteHeader(status)
	_ = testPage.Execute(w, struct {
		OK   bool
		Code string
	}{ok, code})
}

// ---- test flows ----

const (
	testTTL     = 15 * time.Minute
	maxTestRuns = 32
)

type testFlow struct {
	provider string
	prov     extProvider
	hash     string
	created  time.Time
	status   string // pending, ok, failed
	errCode  string
	user     string
}

type testFlows struct {
	mu sync.Mutex
	m  map[string]*testFlow
}

func newTestFlows() *testFlows { return &testFlows{m: map[string]*testFlow{}} }

func (t *testFlows) add(tf *testFlow) string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	tok := base64.RawURLEncoding.EncodeToString(b)
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	for k, v := range t.m {
		if now.Sub(v.created) > testTTL {
			delete(t.m, k)
		}
	}
	if len(t.m) >= maxTestRuns {
		var oldest string
		for k, v := range t.m {
			if oldest == "" || v.created.Before(t.m[oldest].created) {
				oldest = k
			}
		}
		delete(t.m, oldest)
	}
	tf.created, tf.status = now, "pending"
	t.m[tok] = tf
	return tok
}

func (t *testFlows) get(tok string) *testFlow {
	t.mu.Lock()
	defer t.mu.Unlock()
	tf := t.m[tok]
	if tf == nil || time.Since(tf.created) > testTTL {
		return nil
	}
	return tf
}

func (t *testFlows) finish(tok, user, code string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if tf := t.m[tok]; tf != nil {
		if code == "" {
			tf.status, tf.user, tf.errCode = "verified", user, ""
		} else {
			tf.status, tf.errCode = "failed", code
		}
	}
}

// testStatus: status is pending, verified or failed.
type testStatus struct {
	Status  string `json:"status"`
	Error   string `json:"error,omitempty"`
	Message string `json:"message,omitempty"`
	User    string `json:"user,omitempty"`
}

// loginErrorText is the Russian text for a login error code.
func loginErrorText(code string) string {
	switch code {
	case "state_mismatch", "flow_expired", "test_expired":
		return "Сеанс входа устарел или повреждён, начните заново"
	case "code_exchange_failed":
		return "Провайдер не выдал токен: проверьте client secret и redirect URL"
	case "invalid_id_token", "nonce_mismatch":
		return "Провайдер вернул недействительный токен"
	case "user_not_allowed":
		return "Пользователя нет в списке разрешённых"
	case "email_not_verified":
		return "E-mail пользователя не подтверждён у провайдера"
	case "idp_error":
		return "Провайдер вернул ошибку"
	case "oidc_not_configured", "not_configured":
		return "Провайдер не настроен"
	}
	return "Проверка не пройдена"
}

func (t *testFlows) status(tok string) (testStatus, string, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	tf := t.m[tok]
	if tf == nil || time.Since(tf.created) > testTTL {
		return testStatus{}, "", false
	}
	st := testStatus{Status: tf.status, Error: tf.errCode, User: tf.user}
	if tf.status == "failed" {
		st.Message = loginErrorText(tf.errCode)
	}
	return st, tf.provider, true
}
