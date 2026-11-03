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
	"strings"
	"sync"
	"time"

	"github.com/bropines/jackett-ui/server/internal/auth"
	"github.com/bropines/jackett-ui/server/internal/auth/github"
	"github.com/bropines/jackett-ui/server/internal/auth/oidc"
	"github.com/bropines/jackett-ui/server/internal/config"
	"github.com/bropines/jackett-ui/server/internal/store"
)

// extProvider is a configured external login provider. Adding a provider
// kind = a providerFactory plus an adapter implementing this.
type extProvider interface {
	start(w http.ResponseWriter, r *http.Request, s oidc.Signer, returnPath, testToken string, secure bool) (string, error)
	finish(w http.ResponseWriter, r *http.Request, s oidc.Signer, secure bool) (extResult, error)
}

// extResult is a finished, allow-listed external login.
type extResult struct {
	User       string
	ReturnPath string
	TestToken  string
}

// providerFactory builds an extProvider for the effective provider config,
// the allow-lists of eff and the redirect URL. It may do network I/O
// (OIDC discovery).
type providerFactory func(ctx context.Context, p config.Provider, eff config.Effective, redirect string) (extProvider, error)

// errNoAllowList: no allow-list could admit users of this provider, so the
// login is refused before it starts.
var errNoAllowList = errors.New("allowlist_required")

// ---- oidc / google ----

type oidcAdapter struct{ p *oidc.Provider }

func (a oidcAdapter) start(w http.ResponseWriter, r *http.Request, s oidc.Signer, rp, tt string, secure bool) (string, error) {
	return a.p.Start(w, r, s, rp, tt, secure)
}

func (a oidcAdapter) finish(w http.ResponseWriter, r *http.Request, s oidc.Signer, secure bool) (extResult, error) {
	// The oidc package enforces the allow-lists we pass in its Config
	// (verified e-mail ∈ AUTH_ALLOWED_EMAILS, or group ∈ OIDC_ALLOWED_GROUPS).
	res, err := a.p.Finish(w, r, s, secure)
	if err != nil {
		return extResult{}, err
	}
	return extResult{User: res.Identity.User, ReturnPath: res.ReturnPath, TestToken: res.TestToken}, nil
}

func (s *Server) oidcFactory(ctx context.Context, p config.Provider, eff config.Effective, redirect string) (extProvider, error) {
	if !eff.ProviderCanAllow(p.ID) {
		return nil, errNoAllowList
	}
	cfg := oidc.Config{
		Issuer:        p.Issuer.Value,
		ClientID:      p.ClientID.Value,
		ClientSecret:  p.ClientSecret.Value,
		Scopes:        strings.Fields(p.Scopes.Value),
		AllowedEmails: eff.AllowedEmails.Value,
		RedirectURL:   redirect,
	}
	if p.ID == config.ProviderGoogle {
		cfg.Issuer = s.googleIssuer
	}
	if p.ID == config.ProviderOIDC {
		cfg.AllowedGroups = p.Groups.Value
		cfg.GroupsClaim = p.GroupsClaim.Value
	}
	if len(cfg.AllowedEmails) == 0 && len(cfg.AllowedGroups) == 0 {
		// Never hand the oidc package empty lists: that means "anyone".
		return nil, errNoAllowList
	}
	op, err := oidc.New(ctx, cfg, s.httpClient)
	if err != nil {
		return nil, err
	}
	return oidcAdapter{op}, nil
}

// ---- github ----

type githubAdapter struct {
	p      *github.Provider
	emails []string
	users  []string
}

func (a githubAdapter) start(w http.ResponseWriter, r *http.Request, s oidc.Signer, rp, tt string, secure bool) (string, error) {
	return a.p.Start(w, r, s, rp, tt, secure)
}

func (a githubAdapter) finish(w http.ResponseWriter, r *http.Request, s oidc.Signer, secure bool) (extResult, error) {
	res, err := a.p.Finish(w, r, s, secure)
	if err != nil {
		return extResult{}, err
	}
	id := res.Identity
	// Email is only set when it is GitHub's primary verified address.
	allowed := (id.Email != "" && containsFold(a.emails, id.Email)) || (id.Login != "" && containsFold(a.users, id.Login))
	if !allowed {
		return extResult{}, oidc.ErrNotAllowed
	}
	return extResult{User: id.User(), ReturnPath: res.ReturnPath, TestToken: res.TestToken}, nil
}

func (s *Server) githubFactory(_ context.Context, p config.Provider, eff config.Effective, redirect string) (extProvider, error) {
	if !eff.ProviderCanAllow(p.ID) {
		return nil, errNoAllowList
	}
	gp, err := github.New(github.Config{
		ClientID:     p.ClientID.Value,
		ClientSecret: p.ClientSecret.Value,
		RedirectURL:  redirect,
		Endpoints:    s.githubEndpoints,
	}, s.httpClient)
	if err != nil {
		return nil, err
	}
	return githubAdapter{p: gp, emails: eff.AllowedEmails.Value, users: eff.GitHubUsers.Value}, nil
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

// ---- provider cache ----

// provRetry: after a failed build (e.g. discovery), wait this long before
// trying again, so public login clicks can't hammer the IdP.
const provRetry = 30 * time.Second

type provEntry struct {
	prov extProvider
	err  error
	at   time.Time
}

func providerKey(p config.Provider, eff config.Effective, redirect string) string {
	h := sha256.New()
	for _, v := range []string{p.ID, p.Hash(), redirect, p.GroupsClaim.Value,
		strings.Join(p.Groups.Value, ","), strings.Join(eff.AllowedEmails.Value, ","), strings.Join(eff.GitHubUsers.Value, ",")} {
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
	key := providerKey(p, re.eff, redirect)
	s.provMu.Lock()
	if e, ok := s.provCache[key]; ok && (e.err == nil || s.now().Sub(e.at) < provRetry) {
		s.provMu.Unlock()
		return e.prov, e.err
	}
	s.provMu.Unlock()

	bctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	prov, err := s.factories[id](bctx, p, re.eff, redirect)
	cancel()
	if err != nil && !errors.Is(err, errNoAllowList) {
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

func authErrorRedirect(w http.ResponseWriter, r *http.Request, code string) {
	http.Redirect(w, r, "/?authError="+code, http.StatusFound)
}

// errCode maps login errors to fixed codes. Never put err.Error() in a URL:
// it may contain IdP-provided text.
func errCode(err error) string {
	if errors.Is(err, errNoAllowList) {
		return oidc.ErrNotAllowed.Error()
	}
	if errors.Is(err, oidc.ErrNotAllowed) && strings.Contains(err.Error(), "not verified") {
		// The oidc package refuses an unverified e-mail with this wording;
		// only a fixed code goes into the URL.
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

func (s *Server) handleProviderStart(w http.ResponseWriter, r *http.Request, re *reqEnv, id string) {
	secure := re.rv.Secure(r)
	if tok := r.URL.Query().Get("test"); tok != "" {
		tf := s.tests.get(tok)
		if tf == nil || tf.provider != id {
			s.renderTestPage(w, false, "test_expired")
			return
		}
		u, err := tf.prov.start(w, r, s.flowSigner, "/", tok, secure)
		if err != nil {
			s.tests.finish(tok, "", errCode(err))
			s.renderTestPage(w, false, errCode(err))
			return
		}
		http.Redirect(w, r, u, http.StatusFound)
		return
	}
	if re.eff.Mode.Value != auth.ModeSSO {
		authErrorRedirect(w, r, "provider_disabled")
		return
	}
	if !providerOffered(re.eff, id) {
		authErrorRedirect(w, r, "provider_disabled")
		return
	}
	prov, err := s.provider(r.Context(), re, r, id)
	if err != nil {
		if errors.Is(err, errNoAllowList) {
			authErrorRedirect(w, r, oidc.ErrNotAllowed.Error())
			return
		}
		authErrorRedirect(w, r, "not_configured")
		return
	}
	u, err := prov.start(w, r, s.flowSigner, oidc.SanitizeReturnPath(r.URL.Query().Get("return")), "", secure)
	if err != nil {
		s.log.Warn("login start failed", "provider", id, "error", err)
		authErrorRedirect(w, r, "not_configured")
		return
	}
	http.Redirect(w, r, u, http.StatusFound)
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

	if tok := oidc.FlowTestToken(r, s.flowSigner); tok != "" {
		s.finishTest(w, r, id, tok, secure)
		return
	}

	if re.eff.Mode.Value != auth.ModeSSO || !providerOffered(re.eff, id) {
		s.clearFlowCookie(w, secure)
		authErrorRedirect(w, r, "provider_disabled")
		return
	}
	prov, err := s.provider(r.Context(), re, r, id)
	if err != nil {
		s.clearFlowCookie(w, secure)
		if errors.Is(err, errNoAllowList) {
			authErrorRedirect(w, r, oidc.ErrNotAllowed.Error())
			return
		}
		authErrorRedirect(w, r, "not_configured")
		return
	}
	res, err := prov.finish(w, r, s.flowSigner, secure)
	if err == nil && res.TestToken != "" {
		err = oidc.ErrState
	}
	if err != nil {
		s.log.Warn("login failed", "ip", ip, "method", id, "error", err)
		authErrorRedirect(w, r, errCode(err))
		return
	}
	s.log.Info("login ok", "ip", ip, "user", res.User, "method", id)
	s.issueSession(w, r, re, res.User, auth.ModeSSO, re.eff.Epoch)
	http.Redirect(w, r, oidc.SanitizeReturnPath(res.ReturnPath), http.StatusFound)
}

// finishTest completes a settings "test login": on success it stores the
// tested settings' hash as verified. The caller's session is not changed.
func (s *Server) finishTest(w http.ResponseWriter, r *http.Request, id, tok string, secure bool) {
	tf := s.tests.get(tok)
	if tf == nil || tf.provider != id {
		s.clearFlowCookie(w, secure)
		s.renderTestPage(w, false, "test_expired")
		return
	}
	res, err := tf.prov.finish(w, r, s.flowSigner, secure)
	if err == nil && res.TestToken != tok {
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
	s.log.Info("test login ok, provider settings verified", "provider", id, "user", res.User)
	s.tests.finish(tok, res.User, "")
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
